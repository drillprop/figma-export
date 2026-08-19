#!/usr/bin/env node
// Build a self-contained visual comparator (for a human) from two screenshots:
// your BUILD vs the DESIGN. Modes: Slider, Onion-skin, Blink, and Box-diff. The Box-diff overlay
// is ON by default: the script auto-loads ./pairs.json (from box-diff.mjs) if it exists — no flag
// needed. Point elsewhere with --boxes <path>, or --no-boxes to skip it. box-diff.mjs must have run
// first to produce pairs.json (this script only takes the two PNGs). No install (Node built-ins).
// Usage: node make-compare.mjs <build.png> <design.png> [out.html] [--boxes pairs.json] [--no-boxes]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { extname } from "node:path";

const argv = process.argv.slice(2);
const bi = argv.indexOf("--boxes");
const boxesArg = bi >= 0 ? argv[bi + 1] : null;         // explicit path, if given
const noBoxes = argv.includes("--no-boxes");
const pos = argv.filter((a, i) => a !== "--boxes" && a !== "--no-boxes" && (bi < 0 || i !== bi + 1));
const [buildPath, designPath, out = "compare.html"] = pos;
if (!buildPath || !designPath) {
  console.error("Usage: node make-compare.mjs <build.png> <design.png> [out.html] [--boxes pairs.json] [--no-boxes]");
  process.exit(2);
}
// Default ON: fall back to ./pairs.json when no path is given. An explicit --boxes that's missing is
// a user error (fail loud); a missing default just means "run box-diff first" (warn, carry on).
const boxesFile = noBoxes ? null : (boxesArg ?? "pairs.json");
if (boxesArg && !existsSync(boxesArg)) { console.error(`--boxes ${boxesArg} not found`); process.exit(2); }
if (boxesFile && !boxesArg && !existsSync(boxesFile)) console.warn(`note: no ./pairs.json — Box-diff overlay off. Run box-diff.mjs to create it, or pass --no-boxes to silence this.`);
const mime = (p) => ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[extname(p).toLowerCase()] || "image/png");
const dataURI = (p) => `data:${mime(p)};base64,${readFileSync(p).toString("base64")}`;
const A = dataURI(buildPath), B = dataURI(designPath);
// keep only the fields the overlay needs, to stay small
const useBoxes = boxesFile && existsSync(boxesFile);
const pairs = useBoxes ? JSON.parse(readFileSync(boxesFile, "utf8")).map((p) => ({ f: p.figma, d: p.dom, dx: p.dx, dy: p.dy, dw: p.dw, dh: p.dh })) : [];
const boxBtn = useBoxes ? `<button data-mode="boxdiff">Box-diff</button>` : "";

writeFileSync(out, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Build vs Design</title><style>
  *{box-sizing:border-box}
  body{margin:0;font:13px/1.4 ui-sans-serif,system-ui,sans-serif;background:#e5e7eb;color:#111}
  .toolbar{position:sticky;top:0;z-index:10;display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:10px 14px;background:#111827;color:#fff}
  .toolbar b{font-weight:600}
  .toolbar button{border:1px solid #374151;background:#1f2937;color:#e5e7eb;padding:5px 10px;border-radius:6px;cursor:pointer}
  .toolbar button.on{background:#2563eb;border-color:#2563eb;color:#fff}
  .toolbar label{display:flex;align-items:center;gap:6px}
  .key{margin-left:auto;opacity:.8}
  .stage{position:relative;width:var(--w);margin:16px auto;box-shadow:0 2px 20px rgba(0,0,0,.2);background:#fff}
  .stage img{position:absolute;top:0;left:0;width:100%;display:block}
  #imgA{position:relative}
  .divider{position:absolute;top:0;bottom:0;width:2px;background:#2563eb;cursor:ew-resize;z-index:5;display:none}
  .divider::after{content:"⇔";position:absolute;top:8px;left:-9px;background:#2563eb;color:#fff;border-radius:4px;padding:1px 3px;font-size:11px}
  #boxes{position:absolute;inset:0;width:100%;height:100%;display:none;pointer-events:none;z-index:6}
  #boxes .f{fill:none;stroke:#16a34a;stroke-dasharray:4 3}
  #boxes .ok{fill:none;stroke:#9ca3af}
  #boxes .bad{fill:none;stroke:#db2777}
  #boxes text{fill:#db2777;font:12px ui-sans-serif,sans-serif}
</style></head><body>
<div class="toolbar">
  <b>Build&nbsp;vs&nbsp;Design</b>
  <button data-mode="slider" class="on">Slider</button>
  <button data-mode="onion">Onion-skin</button>
  <button data-mode="blink">Blink</button>
  ${boxBtn}
  <label>scale <input id="scale" type="range" min="20" max="100" value="50">%</label>
  <span class="key">A = your build · B = design${useBoxes ? " · Box-diff: green = design, magenta = build" : ""}</span>
</div>
<div class="stage" id="stage">
  <img id="imgA" src="${A}" alt="A: your build">
  <img id="imgB" src="${B}" alt="B: design">
  <svg id="boxes" preserveAspectRatio="none"></svg>
  <div class="divider" id="divider"></div>
</div>
<script>
const PAIRS=${JSON.stringify(pairs)};
const stage=document.getElementById('stage'),imgA=document.getElementById('imgA'),imgB=document.getElementById('imgB'),divider=document.getElementById('divider'),boxes=document.getElementById('boxes');
let mode='slider',blink=null;
function setScale(){const pct=+document.getElementById('scale').value;const w=()=>stage.style.setProperty('--w',(imgA.naturalWidth*pct/100)+'px');imgA.naturalWidth?w():imgA.addEventListener('load',w,{once:true});}
document.getElementById('scale').oninput=setScale;
function buildBoxes(){
  if(!PAIRS.length)return;
  boxes.setAttribute('viewBox','0 0 '+imgA.naturalWidth+' '+imgA.naturalHeight);
  let s='';
  for(const p of PAIRS){
    const off=Math.abs(p.dx)>4||Math.abs(p.dy)>4||Math.abs(p.dw)>4||Math.abs(p.dh)>4;
    s+='<rect class="f" x="'+p.f.x+'" y="'+p.f.y+'" width="'+p.f.w+'" height="'+p.f.h+'" vector-effect="non-scaling-stroke"/>';
    s+='<rect class="'+(off?'bad':'ok')+'" x="'+p.d.x+'" y="'+p.d.y+'" width="'+p.d.w+'" height="'+p.d.h+'" vector-effect="non-scaling-stroke"/>';
    if(off)s+='<text x="'+p.d.x+'" y="'+(p.d.y-2)+'">Δ'+p.dx+','+p.dy+(p.dw?(' w'+p.dw):'')+(p.dh?(' h'+p.dh):'')+'</text>';
  }
  boxes.innerHTML=s;
}
function apply(){
  clearInterval(blink);blink=null;
  imgB.style.opacity=1;imgB.style.clipPath='none';imgB.style.visibility='visible';divider.style.display='none';stage.onmousemove=null;
  boxes.style.display='none';imgA.style.filter='none';
  if(mode==='slider'){
    divider.style.display='block';
    const move=x=>{const r=stage.getBoundingClientRect();const px=Math.max(0,Math.min(x-r.left,r.width));imgB.style.clipPath='inset(0 0 0 '+px+'px)';divider.style.left=px+'px';};
    const r=stage.getBoundingClientRect();move(r.left+r.width/2);
    stage.onmousemove=e=>{if(e.buttons)move(e.clientX);};divider.onmousedown=()=>{stage.onmousemove=e=>move(e.clientX);};
  } else if(mode==='onion'){imgB.style.opacity=0.5;}
  else if(mode==='blink'){let on=true;blink=setInterval(()=>{imgB.style.visibility=(on=!on)?'visible':'hidden';},500);}
  else if(mode==='boxdiff'){imgB.style.visibility='hidden';imgA.style.filter='grayscale(1) brightness(1.2) contrast(.6)';boxes.style.display='block';}
}
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-mode]').forEach(x=>x.classList.remove('on'));b.classList.add('on');mode=b.dataset.mode;apply();});
if(imgA.naturalWidth)buildBoxes();else imgA.addEventListener('load',buildBoxes,{once:true});
setScale();apply();
</script></body></html>`);
console.log(`wrote ${out}  (build=${buildPath}, design=${designPath}${useBoxes ? `, boxes=${boxesFile} [${pairs.length}]` : ""})`);
