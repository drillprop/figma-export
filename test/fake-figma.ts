// Deterministic in-memory stand-in for the slice of the Figma Plugin API the
// export core touches, over one sample document. Values are typed against
// @figma/plugin-typings so the fake returns what Figma would.

type Mixed = typeof figma.mixed;

type NodeProps = Partial<
  Pick<
    FrameNode,
    | "visible" | "opacity" | "x" | "y" | "width" | "height" | "fills" | "strokes"
    | "strokeWeight" | "effects" | "cornerRadius" | "layoutMode" | "itemSpacing"
    | "paddingLeft" | "paddingRight" | "paddingTop" | "paddingBottom" | "fillStyleId"
    | "strokeStyleId" | "effectStyleId" | "gridStyleId" | "boundVariables"
  > &
    Pick<TextNode, "characters" | "fontSize" | "fontName" | "textStyleId"> &
    Pick<ComponentNode, "key" | "description" | "remote" | "componentPropertyDefinitions"> &
    Pick<InstanceNode, "componentProperties">
>;

type Segment = Pick<StyledTextSegment, "characters" | "start" | "end" | "textStyleId" | "fillStyleId">;

interface NodeSpec extends NodeProps {
  id: string;
  name: string;
  type: NodeType;
  children?: NodeSpec[];
  /** INSTANCE only: id of its main component. */
  main?: string;
  svg?: string;
  segments?: Segment[];
  /** Remote component whose import by key fails. */
  unpublished?: true;
}

type FakeNode = Record<string, unknown> & {
  id: string;
  name: string;
  type: NodeType;
  parent: FakeNode | null;
  children?: FakeNode[];
};

type FakeStyle =
  | Pick<PaintStyle, "id" | "key" | "name" | "remote" | "description" | "type" | "paints" | "boundVariables">
  | Pick<
      TextStyle,
      | "id" | "key" | "name" | "remote" | "description" | "type" | "fontName" | "fontSize"
      | "lineHeight" | "letterSpacing" | "textCase" | "textDecoration" | "paragraphSpacing"
      | "paragraphIndent" | "boundVariables"
    >
  | Pick<EffectStyle, "id" | "key" | "name" | "remote" | "description" | "type" | "effects">
  | Pick<GridStyle, "id" | "key" | "name" | "remote" | "description" | "type" | "layoutGrids">;

type FakeVariable = Pick<
  Variable,
  "id" | "name" | "key" | "remote" | "resolvedType" | "description" | "variableCollectionId" | "scopes" | "valuesByMode"
>;

type FakeCollection = Pick<
  VariableCollection,
  "id" | "name" | "key" | "remote" | "defaultModeId" | "modes" | "variableIds"
>;

const FILE_KEY = "FAKEfile0123456789";
const TARGET_ID = "12:34";
const IMAGE_PNG_HASH = "4f1c0a9be7d25d0c8e3a6b1f2a7c9d0e1b2c3d4e";
const IMAGE_JPG_HASH = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b";
const HIDDEN_NODE_IMAGE_HASH = "1111111111111111111111111111111111111111";
const HIDDEN_FILL_IMAGE_HASH = "2222222222222222222222222222222222222222";

function rasterBytes(magic: number[], seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(magic);
  for (let i = magic.length; i < length; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];

const previewPng = rasterBytes(PNG_MAGIC, 3, 301);
const embeddedPng = rasterBytes(PNG_MAGIC, 7, 98);
const embeddedJpg = rasterBytes(JPG_MAGIC, 11, 61);
const imagePng = rasterBytes(PNG_MAGIC, 13, 157);
const imageJpg = rasterBytes(JPG_MAGIC, 17, 83);

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const TARGET_SVG =
  '<svg width="320" height="200" viewBox="0 0 320 200" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
  "<title>Zażółć 🎨</title>" +
  '<rect width="320" height="200" rx="8" fill="#3366FF"/>' +
  `<image x="16" y="16" width="48" height="48" href="data:image/png;base64,${base64(embeddedPng)}"/>` +
  `<image x="72" y="16" width="48" height="48" xlink:href="data:image/png;base64,${base64(embeddedPng)}"/>` +
  `<image x="16" y="72" width="288" height="96" href="data:image/jpeg;base64,${base64(embeddedJpg)}"/>` +
  "</svg>\n";

const alias = (id: string): VariableAlias => ({ type: "VARIABLE_ALIAS", id });
const solid = (r: number, g: number, b: number, boundTo?: string): SolidPaint => ({
  type: "SOLID",
  visible: true,
  opacity: 1,
  blendMode: "NORMAL",
  color: { r, g, b },
  ...(boundTo ? { boundVariables: { color: alias(boundTo) } } : {}),
});
const imageFill = (imageHash: string, visible = true): ImagePaint => ({
  type: "IMAGE",
  visible,
  opacity: 1,
  blendMode: "NORMAL",
  scaleMode: "FILL",
  imageHash,
});
const shadow: DropShadowEffect = {
  type: "DROP_SHADOW",
  visible: true,
  blendMode: "NORMAL",
  color: { r: 0, g: 0, b: 0, a: 0.25 },
  offset: { x: 0, y: 4 },
  radius: 12,
  spread: 0,
  showShadowBehindNode: false,
};
const vector = (id: string, name: string, fills: Paint[] = [solid(0, 0, 0)]): NodeSpec => ({
  id,
  name,
  type: "VECTOR",
  visible: true,
  width: 16,
  height: 16,
  fills,
});

function sampleDocument(mixed: Mixed): { root: NodeSpec; library: NodeSpec[] } {
  const target: NodeSpec = {
    id: TARGET_ID,
    name: 'Profile card <Zażółć> & "co"',
    type: "FRAME",
    visible: true,
    opacity: 1,
    x: 0,
    y: 0,
    width: 320,
    height: 200,
    cornerRadius: 8,
    fills: [solid(0.2, 0.4, 1, "V:button")],
    strokes: [],
    effects: [shadow],
    layoutMode: "VERTICAL",
    itemSpacing: 12,
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 16,
    paddingBottom: 16,
    fillStyleId: "S:paint-primary",
    strokeStyleId: "S:missing",
    effectStyleId: "S:effect-shadow",
    gridStyleId: "S:grid-8",
    boundVariables: {
      fills: [alias("V:button")],
      itemSpacing: alias("V:space-md"),
      paddingLeft: alias("V:gone"),
    },
    svg: TARGET_SVG,
    children: [
      {
        id: "12:35",
        name: "Title",
        type: "TEXT",
        visible: true,
        width: 288,
        height: 40,
        characters: "Zażółć gęślą 🎨",
        fontSize: mixed,
        fontName: mixed,
        textStyleId: mixed,
        fillStyleId: "S:paint-primary",
        fills: [solid(0.1, 0.1, 0.1)],
        segments: [
          { characters: "Zażółć ", start: 0, end: 7, textStyleId: "S:text-h1", fillStyleId: "S:paint-primary" },
          { characters: "gęślą ", start: 7, end: 13, textStyleId: "S:text-remote", fillStyleId: "S:paint-primary" },
          { characters: "🎨", start: 13, end: 15, textStyleId: "", fillStyleId: "S:paint-primary" },
        ],
      },
      {
        id: "12:36",
        name: "Body",
        type: "TEXT",
        visible: true,
        width: 288,
        height: 60,
        characters:
          "A short   biography\nthat runs well past the sixty character sample cut-off used in the summary.",
        fontSize: 14,
        fontName: { family: "Inter", style: "Regular" },
        textStyleId: "S:text-body",
        fillStyleId: "",
        fills: [solid(0.3, 0.3, 0.3)],
      },
      {
        id: "12:37",
        name: "Badge",
        type: "COMPONENT",
        visible: true,
        width: 48,
        height: 20,
        key: "badge-key",
        description: "Status badge",
        remote: false,
        componentPropertyDefinitions: { "Label#12:0": { type: "TEXT", defaultValue: "New" } },
        fills: [solid(1, 0.8, 0)],
        children: [
          {
            id: "12:38",
            name: "Label",
            type: "TEXT",
            visible: true,
            width: 30,
            height: 14,
            characters: "New",
            textStyleId: "S:text-body",
            fills: [solid(0, 0, 0)],
          },
        ],
      },
      {
        id: "12:39",
        name: "Button",
        type: "INSTANCE",
        main: "20:3",
        visible: true,
        width: 120,
        height: 40,
        componentProperties: {
          Size: { type: "VARIANT", value: "md" },
          Style: { type: "VARIANT", value: "Primary" },
        },
        fills: [solid(0.2, 0.4, 1)],
        children: [
          {
            id: "12:40",
            name: "Label",
            type: "TEXT",
            visible: true,
            width: 80,
            height: 20,
            characters: "Continue",
            textStyleId: "S:text-body",
            fills: [solid(1, 1, 1)],
          },
        ],
      },
      {
        id: "12:41",
        name: "Close",
        type: "INSTANCE",
        main: "L:2",
        visible: true,
        width: 16,
        height: 16,
        componentProperties: { Name: { type: "VARIANT", value: "Close" } },
        svg: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M2 2L14 14M14 2L2 14" stroke="#000"/></svg>\n',
        children: [vector("12:42", "Vector")],
      },
      {
        id: "12:43",
        name: "Close",
        type: "INSTANCE",
        main: "L:2",
        visible: true,
        width: 16,
        height: 16,
        componentProperties: { Name: { type: "VARIANT", value: "Close" } },
        children: [vector("12:44", "Vector")],
      },
      {
        id: "12:45",
        name: "Star",
        type: "COMPONENT",
        visible: true,
        width: 16,
        height: 16,
        key: "star-key",
        description: "",
        remote: false,
        componentPropertyDefinitions: {},
        svg: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 1L10 6H15L11 9L12.5 14L8 11L3.5 14L5 9L1 6H6Z" fill="#FFB800"/></svg>\n',
        children: [vector("12:46", "Star shape", [solid(1, 0.72, 0)])],
      },
      {
        id: "12:47",
        name: "Avatar",
        type: "INSTANCE",
        main: "L:9",
        visible: true,
        width: 288,
        height: 96,
        componentProperties: {},
        children: [
          { id: "12:48", name: "Photo", type: "RECTANGLE", visible: true, width: 48, height: 48, fills: [imageFill(IMAGE_PNG_HASH)] },
          { id: "12:49", name: "Photo copy", type: "RECTANGLE", visible: true, width: 48, height: 48, fills: [imageFill(IMAGE_PNG_HASH)] },
          { id: "12:50", name: "Hidden photo", type: "RECTANGLE", visible: false, width: 48, height: 48, fills: [imageFill(HIDDEN_NODE_IMAGE_HASH)] },
          {
            id: "12:51",
            name: "Banner",
            type: "RECTANGLE",
            visible: true,
            width: 288,
            height: 96,
            fills: [imageFill(IMAGE_JPG_HASH), imageFill(HIDDEN_FILL_IMAGE_HASH, false)],
          },
        ],
      },
      { id: "12:52", name: "Spacer", type: "FRAME", visible: true, width: 0, height: 8, fills: [], children: [] },
      {
        id: "12:53",
        name: "Plus",
        type: "INSTANCE",
        main: "L:3",
        visible: false,
        width: 16,
        height: 16,
        componentProperties: { Name: { type: "VARIANT", value: "Plus" } },
        children: [vector("12:54", "Vector")],
      },
      {
        id: "12:55",
        name: "Tag",
        type: "INSTANCE",
        main: "L:10",
        visible: true,
        width: 64,
        height: 24,
        componentProperties: { "Text#1:2": { type: "TEXT", value: "Beta" } },
        children: [
          { id: "12:56", name: "Text", type: "TEXT", visible: true, width: 40, height: 16, characters: "Beta", textStyleId: "S:text-remote" },
        ],
      },
    ],
  };

  const buttonSet: NodeSpec = {
    id: "20:1",
    name: "Button",
    type: "COMPONENT_SET",
    visible: true,
    width: 300,
    height: 120,
    key: "button-set-key",
    description: "Primary action",
    remote: false,
    componentPropertyDefinitions: {
      Size: { type: "VARIANT", defaultValue: "sm", variantOptions: ["sm", "md"] },
      Style: { type: "VARIANT", defaultValue: "Primary", variantOptions: ["Primary"] },
    },
    children: [
      { id: "20:2", name: "Size=sm, Style=Primary", type: "COMPONENT", visible: true, width: 96, height: 32, key: "button-sm-key", description: "", remote: false },
      {
        id: "20:3",
        name: "Size=md, Style=Primary",
        type: "COMPONENT",
        visible: true,
        width: 120,
        height: 40,
        key: "button-md-key",
        description: "",
        remote: false,
        children: [{ id: "20:4", name: "Label", type: "TEXT", visible: true, width: 80, height: 20, characters: "Button" }],
      },
    ],
  };

  const iconSet: NodeSpec = {
    id: "L:1",
    name: "Icon",
    type: "COMPONENT_SET",
    visible: true,
    width: 64,
    height: 32,
    key: "icon-set-key",
    description: "Library icons",
    remote: true,
    componentPropertyDefinitions: {
      Name: { type: "VARIANT", defaultValue: "Close", variantOptions: ["Close", "Plus"] },
    },
    children: [
      {
        id: "L:2",
        name: "Name=Close",
        type: "COMPONENT",
        visible: true,
        width: 16,
        height: 16,
        key: "icon-close-key",
        description: "Close icon",
        remote: true,
        children: [vector("L:4", "Vector", [solid(0, 0, 0, "V:lib-icon")])],
      },
      {
        id: "L:3",
        name: "Name=Plus",
        type: "COMPONENT",
        visible: true,
        width: 16,
        height: 16,
        key: "icon-plus-key",
        description: "",
        remote: true,
        children: [vector("L:5", "Vector")],
      },
    ],
  };

  const avatar: NodeSpec = {
    id: "L:9",
    name: "Avatar",
    type: "COMPONENT",
    visible: true,
    width: 288,
    height: 96,
    key: "avatar-key",
    description: "",
    remote: true,
    componentPropertyDefinitions: {},
    unpublished: true,
  };

  const tag: NodeSpec = {
    id: "L:10",
    name: "Tag",
    type: "COMPONENT",
    visible: true,
    width: 64,
    height: 24,
    key: "tag-key",
    description: "Library tag",
    remote: true,
    componentPropertyDefinitions: { "Text#1:2": { type: "TEXT", defaultValue: "Tag" } },
    children: [
      { id: "L:11", name: "Text", type: "TEXT", visible: true, width: 40, height: 16, characters: "Tag", textStyleId: "S:text-remote" },
    ],
  };

  const root: NodeSpec = {
    id: "0:0",
    name: "Sample file · Zażółć",
    type: "DOCUMENT",
    children: [{ id: "0:1", name: "Page 1", type: "PAGE", children: [target, buttonSet] }],
  };
  return { root, library: [iconSet, avatar, tag] };
}

const COLLECTIONS: FakeCollection[] = [
  {
    id: "VC:theme",
    name: "Theme",
    key: "theme-key",
    remote: false,
    defaultModeId: "M:light",
    modes: [
      { modeId: "M:light", name: "Light" },
      { modeId: "M:dark", name: "Dark" },
    ],
    variableIds: ["V:primary", "V:brand", "V:button", "V:space-md", "V:label", "V:show-badge"],
  },
  {
    id: "VC:lib",
    name: "Library tokens",
    key: "lib-key",
    remote: true,
    defaultModeId: "M:lib",
    modes: [{ modeId: "M:lib", name: "Default" }],
    variableIds: ["V:lib-icon", "V:lib-base", "V:lib-size"],
  },
];

const local = (
  id: string,
  name: string,
  resolvedType: VariableResolvedDataType,
  valuesByMode: FakeVariable["valuesByMode"],
  scopes: VariableScope[] = ["ALL_SCOPES"],
): FakeVariable => ({
  id,
  name,
  key: `${id.slice(2)}-key`,
  remote: false,
  resolvedType,
  description: "",
  variableCollectionId: "VC:theme",
  scopes,
  valuesByMode,
});

const remote = (id: string, name: string, resolvedType: VariableResolvedDataType, value: VariableValue): FakeVariable => ({
  id,
  name,
  key: `${id.slice(2)}-key`,
  remote: true,
  resolvedType,
  description: "From the library",
  variableCollectionId: "VC:lib",
  scopes: ["ALL_SCOPES"],
  valuesByMode: { "M:lib": value },
});

const VARIABLES: FakeVariable[] = [
  local("V:primary", "color/primary", "COLOR", { "M:light": { r: 0.2, g: 0.4, b: 1, a: 1 }, "M:dark": { r: 0.1, g: 0.2, b: 0.6, a: 0.5 } }, ["ALL_FILLS"]),
  local("V:brand", "color/brand", "COLOR", { "M:light": alias("V:primary"), "M:dark": alias("V:primary") }),
  local("V:button", "color/button/bg", "COLOR", { "M:light": alias("V:brand"), "M:dark": { r: 1, g: 1, b: 1 } }),
  local("V:space-md", "space/md", "FLOAT", { "M:light": 16, "M:dark": 16 }, ["GAP", "WIDTH_HEIGHT"]),
  local("V:label", "copy/cta", "STRING", { "M:light": "Continue", "M:dark": "Weiter" }),
  local("V:show-badge", "flags/badge", "BOOLEAN", { "M:light": true, "M:dark": false }),
  remote("V:lib-icon", "icon/fg", "COLOR", alias("V:lib-base")),
  remote("V:lib-base", "base/black", "COLOR", { r: 0, g: 0, b: 0, a: 1 }),
  remote("V:lib-size", "type/caption", "FLOAT", 12),
];

const STYLES: { style: FakeStyle; local: boolean }[] = [
  {
    local: true,
    style: {
      id: "S:paint-primary",
      key: "paint-primary-key",
      name: "Brand/Primary",
      remote: false,
      description: "Main brand colour",
      type: "PAINT",
      paints: [solid(0.2, 0.4, 1, "V:primary")],
      boundVariables: { paints: [alias("V:primary")] },
    },
  },
  {
    local: true,
    style: {
      id: "S:text-h1",
      key: "text-h1-key",
      name: "HD/H1",
      remote: false,
      description: "",
      type: "TEXT",
      fontName: { family: "Inter", style: "Bold" },
      fontSize: 32,
      lineHeight: { value: 40, unit: "PIXELS" },
      letterSpacing: { value: -2, unit: "PERCENT" },
      textCase: "ORIGINAL",
      textDecoration: "NONE",
      paragraphSpacing: 0,
      paragraphIndent: 0,
      boundVariables: {},
    },
  },
  {
    local: true,
    style: {
      id: "S:text-body",
      key: "text-body-key",
      name: "Body/Regular",
      remote: false,
      description: "",
      type: "TEXT",
      fontName: { family: "Inter", style: "Regular" },
      fontSize: 14,
      lineHeight: { unit: "AUTO" },
      letterSpacing: { value: 0, unit: "PIXELS" },
      textCase: "ORIGINAL",
      textDecoration: "NONE",
      paragraphSpacing: 8,
      paragraphIndent: 0,
    },
  },
  {
    local: true,
    style: {
      id: "S:effect-shadow",
      key: "effect-shadow-key",
      name: "Shadow/Card",
      remote: false,
      description: "",
      type: "EFFECT",
      effects: [shadow],
    },
  },
  {
    local: true,
    style: {
      id: "S:grid-8",
      key: "grid-8-key",
      name: "Grid/8pt",
      remote: false,
      description: "",
      type: "GRID",
      layoutGrids: [{ pattern: "GRID", sectionSize: 8, visible: true, color: { r: 1, g: 0, b: 0, a: 0.1 } }],
    },
  },
  {
    local: false,
    style: {
      id: "S:text-remote",
      key: "text-remote-key",
      name: "Library/Caption",
      remote: true,
      description: "Caption from the library",
      type: "TEXT",
      fontName: { family: "Inter", style: "Medium" },
      fontSize: 12,
      lineHeight: { value: 150, unit: "PERCENT" },
      letterSpacing: { value: 0.5, unit: "PIXELS" },
      textCase: "UPPER",
      textDecoration: "UNDERLINE",
      paragraphSpacing: 0,
      paragraphIndent: 0,
      boundVariables: { fontSize: alias("V:lib-size") },
    },
  },
];

const IMAGES = new Map<string, Uint8Array>([
  [IMAGE_PNG_HASH, imagePng],
  [IMAGE_JPG_HASH, imageJpg],
  [HIDDEN_NODE_IMAGE_HASH, imagePng],
  [HIDDEN_FILL_IMAGE_HASH, imageJpg],
]);

const encoder = new TextEncoder();

interface Registry {
  nodes: Map<string, FakeNode>;
  unpublished: Set<FakeNode>;
}

function buildTree(spec: NodeSpec, parent: FakeNode | null, registry: Registry): FakeNode {
  const { children, main, svg, segments, unpublished, componentPropertyDefinitions, ...props } = spec;
  const node: FakeNode = { ...props, parent };

  if (componentPropertyDefinitions !== undefined) node.componentPropertyDefinitions = componentPropertyDefinitions;
  if (spec.type === "COMPONENT" && parent?.type === "COMPONENT_SET") {
    Object.defineProperty(node, "componentPropertyDefinitions", {
      enumerable: true,
      get() {
        throw new Error("Can only get component property definitions of a component set or non-variant component");
      },
    });
  }

  if (children) {
    node.children = children.map((child) => buildTree(child, node, registry));
    node.findAllWithCriteria = ({ types }: { types: NodeType[] }) => {
      const found: FakeNode[] = [];
      const walk = (n: FakeNode) => {
        for (const child of n.children ?? []) {
          if (types.includes(child.type)) found.push(child);
          walk(child);
        }
      };
      walk(node);
      return found;
    };
  }

  if (spec.type !== "DOCUMENT" && spec.type !== "PAGE") {
    node.exportAsync = async (settings?: ExportSettings) => {
      if (settings?.format === "SVG") {
        const text =
          svg ??
          `<svg width="${spec.width}" height="${spec.height}" xmlns="http://www.w3.org/2000/svg"><title>${spec.name}</title></svg>\n`;
        return encoder.encode(text);
      }
      if (settings?.format === "PNG") return previewPng.slice();
      throw new Error(`fake exportAsync: unsupported format ${settings?.format}`);
    };
  }

  if (spec.type === "INSTANCE") {
    node.getMainComponentAsync = async () => (main ? (registry.nodes.get(main) ?? null) : null);
  }

  if (segments) {
    node.getStyledTextSegments = (fields: (keyof Segment)[]) =>
      segments.map((s) => {
        const out: Record<string, unknown> = { characters: s.characters, start: s.start, end: s.end };
        for (const field of fields) out[field] = s[field];
        return out;
      });
  }

  registry.nodes.set(node.id, node);
  if (unpublished) registry.unpublished.add(node);
  return node;
}

export function createFakeFigma() {
  const mixed: Mixed = Symbol("figma.mixed") as unknown as Mixed;
  const { root: rootSpec, library: librarySpecs } = sampleDocument(mixed);
  const registry: Registry = { nodes: new Map(), unpublished: new Set() };
  const { nodes } = registry;
  const root = buildTree(rootSpec, null, registry);
  const documentIds = new Set(nodes.keys());
  for (const spec of librarySpecs) buildTree(spec, null, registry);
  const byKey = (key: string, type: NodeType) =>
    [...nodes.values()].find((n) => n.key === key && n.type === type && n.remote === true);

  const styles = new Map(STYLES.map(({ style }) => [style.id, structuredClone(style)]));
  const localStyles = (type: FakeStyle["type"]) =>
    STYLES.filter((s) => s.local && s.style.type === type).map((s) => styles.get(s.style.id));
  const variables = new Map(VARIABLES.map((v) => [v.id, structuredClone(v)]));
  const collections = new Map(COLLECTIONS.map((c) => [c.id, structuredClone(c)]));

  const variablesApi = {
    getLocalVariableCollectionsAsync: async () => [...collections.values()].filter((c) => !c.remote),
    getVariableByIdAsync: async (id: string) => variables.get(id) ?? null,
    getVariableCollectionByIdAsync: async (id: string) => collections.get(id) ?? null,
  } satisfies Partial<Record<keyof VariablesAPI, unknown>>;

  const figma = {
    mixed,
    fileKey: undefined,
    root,
    variables: variablesApi,
    getNodeByIdAsync: async (id: string) => (documentIds.has(id) ? (nodes.get(id) ?? null) : null),
    getStyleByIdAsync: async (id: string) => styles.get(id) ?? null,
    getLocalPaintStylesAsync: async () => localStyles("PAINT"),
    getLocalTextStylesAsync: async () => localStyles("TEXT"),
    getLocalEffectStylesAsync: async () => localStyles("EFFECT"),
    getLocalGridStylesAsync: async () => localStyles("GRID"),
    getImageByHash: (hash: string): Image | null => {
      const bytes = IMAGES.get(hash);
      if (!bytes) return null;
      return {
        hash,
        getBytesAsync: async () => bytes.slice(),
        getSizeAsync: async () => ({ width: 48, height: 48 }),
      };
    },
    importComponentByKeyAsync: async (key: string) => {
      const found = byKey(key, "COMPONENT");
      if (!found || registry.unpublished.has(found)) throw new Error(`Component with key ${key} is not published`);
      return found;
    },
    importComponentSetByKeyAsync: async (key: string) => {
      const found = byKey(key, "COMPONENT_SET");
      if (!found) throw new Error(`Component set with key ${key} is not published`);
      return found;
    },
  } satisfies Partial<Record<keyof PluginAPI, unknown>>;

  return {
    figma: figma as unknown,
    target: nodes.get(TARGET_ID) as unknown,
    targetId: TARGET_ID,
    fileKey: FILE_KEY,
    bytes: {
      previewPng,
      embeddedPng,
      pngFill: { imageHash: IMAGE_PNG_HASH, bytes: imagePng },
      jpgFill: { imageHash: IMAGE_JPG_HASH, bytes: imageJpg },
    },
  };
}
