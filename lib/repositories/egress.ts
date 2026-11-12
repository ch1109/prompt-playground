import { db } from "./db";

// 材料外发确认记录：(项目, 服务商地址) 第一次发材料前由用户确认一次，只新增

export interface EgressConsent {
  project_id: string;
  provider_host: string;
  confirmed_by: string;
  confirmed_at: string;
}

export function getEgressConsent(projectId: string, host: string): EgressConsent | undefined {
  return db().prepare("SELECT project_id, provider_host, confirmed_by, confirmed_at FROM egress_consents WHERE project_id = ? AND provider_host = ?").get(projectId, host) as EgressConsent | undefined;
}

export function hasEgressConsent(projectId: string, host: string): boolean {
  return !!getEgressConsent(projectId, host);
}

/** 记录确认；已有记录时保持原样（不重复写、不报错） */
export function recordEgressConsent(projectId: string, host: string, by: string): EgressConsent {
  db().prepare("INSERT OR IGNORE INTO egress_consents VALUES (?,?,?,?)").run(projectId, host, by, new Date().toISOString());
  return getEgressConsent(projectId, host)!;
}
