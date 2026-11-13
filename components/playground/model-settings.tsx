"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { ModelSettingsDTO } from "@/lib/client/types";
import { Btn } from "@/components/ui";

const field = "w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 text-[12.5px] outline-none focus:border-ink-400";
const hint = "mt-1 block text-[11px] text-ink-400";

/** 模型设置弹窗：填服务地址、模型名称、密钥；保存前先测试连接。密钥只放在这个组件的 state 里 */
export function ModelSettings({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [cur, setCur] = useState<ModelSettingsDTO | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<ModelSettingsDTO>("/api/settings/model")
      .then((s) => {
        setCur(s);
        setBaseUrl(s.baseUrl);
        setModel(s.model);
      })
      .catch(() => setCur({ source: "none", baseUrl: "", model: "", hasKey: false, keyTail: null }));
  }, []);

  const body = { baseUrl, model, apiKey: apiKey || undefined };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setResult(null);
    try {
      await fn();
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "操作失败" });
    } finally {
      setBusy(false);
    }
  };
  const verdict = (r: { modelFound: boolean; modelCount: number }) => `✓ 连接成功，可用模型 ${r.modelCount} 个` + (r.modelFound ? "" : `，但列表里没有“${model.trim()}”，请检查模型名称`);

  const test = () =>
    run(async () => {
      const r = await api<{ modelFound: boolean; modelCount: number }>("/api/settings/model", { json: body });
      setResult({ ok: true, text: verdict(r) });
    });
  const save = () =>
    run(async () => {
      await api("/api/settings/model", { json: body, method: "PUT" });
      onSaved();
    });
  const restore = () =>
    run(async () => {
      if (!window.confirm("清除这里保存的设置，改用安装时的配置？")) return;
      await api("/api/settings/model", { method: "DELETE" });
      onSaved();
    });

  const keyPlaceholder = cur?.hasKey && cur.source === "settings" ? `已设置${cur.keyTail ? `（末 4 位 ${cur.keyTail}）` : ""}，留空表示不修改` : "";

  return (
    <>
      <div className="fixed inset-0 z-50 bg-ink-100/20 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-label="模型设置" data-testid="model-settings-dialog" className="rise fixed left-1/2 top-1/2 z-50 w-[480px] max-w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.25)]">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">模型设置</h2>
          {cur?.source === "env" && <p className="mt-1 text-[11.5px] text-ink-400">当前使用安装时的配置。在这里保存后，以这里为准。</p>}
        </div>
        <label className="block text-[12px] font-medium">
          服务地址
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" className={`${field} mt-1`} disabled={!cur} data-testid="ms-base-url" />
          <span className={hint}>OpenAI 兼容接口的地址，由模型服务商提供</span>
        </label>
        <label className="block text-[12px] font-medium">
          模型名称
          <input value={model} onChange={(e) => setModel(e.target.value)} className={`${field} mt-1`} disabled={!cur} data-testid="ms-model" />
          <span className={hint}>默认使用的模型，例如 qwen-plus</span>
        </label>
        <label className="block text-[12px] font-medium">
          密钥
          <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={keyPlaceholder} className={`${field} mt-1`} disabled={!cur} data-testid="ms-api-key" />
          <span className={hint}>在服务商的控制台创建，只保存在本机</span>
        </label>
        {result && (
          <p className={result.ok ? "text-[12px] text-verify" : "text-[12px] text-risk"} data-testid="ms-result">
            {result.text}
          </p>
        )}
        <div className="flex items-center gap-1.5 border-t border-ink-800 pt-4">
          {cur?.source === "settings" && (
            <button onClick={restore} disabled={busy} className="text-[11.5px] text-ink-400 hover:text-ink-100 disabled:opacity-40" data-testid="ms-restore">
              恢复安装时的配置
            </button>
          )}
          <Btn onClick={onClose} disabled={busy} className="ml-auto">
            取消
          </Btn>
          <Btn tone="outline" onClick={test} disabled={busy} data-testid="ms-test">
            测试连接
          </Btn>
          <Btn tone="primary" onClick={save} disabled={busy} data-testid="ms-save">
            保存
          </Btn>
        </div>
      </div>
    </>
  );
}
