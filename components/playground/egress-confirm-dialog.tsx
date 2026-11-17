"use client";
import { useEffect, useState } from "react";
import { onEgressAsk, type EgressAsk } from "@/lib/client/egress-confirm";
import { Btn } from "@/components/ui";

/** 第一次把材料发给某个模型服务商时的确认框（与「模型设置」同样的弹窗样式） */
export function EgressConfirmDialog() {
  const [ask, setAsk] = useState<EgressAsk | null>(null);
  useEffect(() => onEgressAsk(setAsk), []);
  if (!ask) return null;
  const done = (ok: boolean) => {
    ask.resolve(ok);
    setAsk(null);
  };
  return (
    <>
      <div className="fixed inset-0 z-50 bg-ink-100/20 backdrop-blur-[2px]" onClick={() => done(false)} aria-hidden="true" />
      <div role="dialog" aria-label="确认外发" data-testid="egress-dialog" className="rise fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 space-y-3 rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.25)]">
        <h2 className="text-[15px] font-semibold tracking-tight">第一次把材料发给 {ask.host}</h2>
        <p className="text-[12.5px] leading-6 text-ink-300">
          这次运行会把输入的文字内容（附带原件图片时还包括原件页面图片）发送给这个模型服务商，其中可能有客户资料。确认后，本项目以后发往这个地址不再询问。
        </p>
        <div className="flex justify-end gap-1.5 border-t border-ink-800 pt-4">
          <Btn onClick={() => done(false)} data-testid="egress-cancel">
            取消
          </Btn>
          <Btn tone="primary" onClick={() => done(true)} data-testid="egress-confirm">
            确认发送
          </Btn>
        </div>
      </div>
    </>
  );
}
