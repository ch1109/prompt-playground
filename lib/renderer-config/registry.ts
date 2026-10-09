import Ajv from "ajv";
import { BINDING_PATTERN, COMPONENT_WHITELIST, type RendererConfig } from "@/lib/contracts/renderer-config";
// 规格包原始配置（v2.0，未修改）
import p1v2 from "@/renderers/jiuli-p1.renderer.json";
import p2v2 from "@/renderers/jiuli-p2.renderer.json";
import p3v2 from "@/renderers/jiuli-p3.renderer.json";
import p4v2 from "@/renderers/jiuli-p4.renderer.json";
// Studio 新增：v3.0 变体
import p1v3 from "@/renderers/v3/jiuli-p1-v3.renderer.json";
import p2v3 from "@/renderers/v3/jiuli-p2-v3.renderer.json";
import p3v3 from "@/renderers/v3/jiuli-p3-v3.renderer.json";
import p4v3 from "@/renderers/v3/jiuli-p4-v3.renderer.json";

const CONFIG_SCHEMA = {
  type: "object",
  required: ["renderer_id", "renderer_config_version", "adapter_id", "layout", "regions"],
  additionalProperties: false,
  properties: {
    renderer_id: { type: "string", pattern: "^[a-z0-9-]+$" },
    renderer_config_version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    adapter_id: { type: "string" },
    supported_prompt_kinds: { type: "array", items: { type: "string" } },
    layout: { enum: ["wide-table-with-issues", "hierarchy-with-issues", "candidate-comparison", "field-decisions-and-patch"] },
    regions: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "component", "binding"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          component: { enum: [...COMPONENT_WHITELIST] },
          binding: { type: "string", pattern: BINDING_PATTERN.source },
          mode: { enum: ["drawer", "inline"] },
          // options 只允许 JSON 标量/数组/对象，组件按已知键读取，不执行任何表达式
          options: { type: "object" },
        },
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(CONFIG_SCHEMA);

export function validateRendererConfig(config: unknown): { ok: boolean; errors: string[] } {
  const ok = validate(config) as boolean;
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
  // options 中不允许出现看起来像代码的字符串
  const json = JSON.stringify((config as { regions?: unknown })?.regions ?? []);
  if (/=>|function\s*\(|<script/i.test(json)) errors.push("options 含有疑似可执行代码");
  return { ok: ok && errors.length === 0, errors };
}

const ALL = [p1v2, p2v2, p3v2, p4v2, p1v3, p2v3, p3v3, p4v3] as unknown[];

export const RENDERER_CONFIGS: RendererConfig[] = [];
export const RENDERER_CONFIG_ERRORS: { id: string; errors: string[] }[] = [];
for (const c of ALL) {
  const r = validateRendererConfig(c);
  if (r.ok) RENDERER_CONFIGS.push(c as RendererConfig);
  else RENDERER_CONFIG_ERRORS.push({ id: String((c as RendererConfig).renderer_id), errors: r.errors });
}

export function findRendererConfig(rendererId: string): RendererConfig | undefined {
  return RENDERER_CONFIGS.find((c) => c.renderer_id === rendererId);
}
