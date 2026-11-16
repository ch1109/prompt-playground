import type { PromptKind } from "@/lib/contracts/run";
import { jiuliP1V2, jiuliP1V3 } from "./jiuli-p1";
import { jiuliP2V2, jiuliP2V3 } from "./jiuli-p2";
import { jiuliP3V2, jiuliP3V3 } from "./jiuli-p3";
import { jiuliP4V2, jiuliP4V3 } from "./jiuli-p4";
import { jiuliP1V15, jiuliP2V15, jiuliP3V15, jiuliP4V15 } from "./jiuli-v15";
import type { BusinessAdapter } from "./types";

/** (promptKind, schemaVersion) → Adapter。新增版本只需注册新 Adapter，不改业务 Prompt 输出 */
export const ADAPTERS: BusinessAdapter[] = [jiuliP1V2, jiuliP2V2, jiuliP3V2, jiuliP4V2, jiuliP1V3, jiuliP2V3, jiuliP3V3, jiuliP4V3, jiuliP1V15, jiuliP2V15, jiuliP3V15, jiuliP4V15];

export function findAdapter(promptKind: PromptKind, schemaVersion: string | undefined): BusinessAdapter | undefined {
  return ADAPTERS.find((a) => a.promptKind === promptKind && a.schemaVersion === schemaVersion);
}

export function findAdapterById(id: string): BusinessAdapter | undefined {
  return ADAPTERS.find((a) => a.adapterId === id);
}
