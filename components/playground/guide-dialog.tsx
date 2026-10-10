"use client";
import { Btn } from "@/components/ui";

const STEPS = [
  { title: "选提示词", desc: "左侧点 P1～P4。每个对应一类九立单据的 AI 指令。" },
  { title: "选样本", desc: "中间「输入 → 样本库」点一个样本。每个样本都标了来源，用来测试。" },
  { title: "点「仅渲染」", desc: "不调用 AI、不花钱，直接把结果整理成表格。点任意单元格，右侧会显示它来自原件的哪一行。" },
];

const TERMS = [
  ["提示词", "发给 AI 的指令。左侧 P1～P4 是四种九立任务。"],
  ["样本", "现成的输入数据，用来试跑，不需要任何配置。"],
  ["仅渲染", "离线把已有输出整理成表格，不调用模型，不花钱。"],
  ["运行模型", "真正调用 AI，会产生费用。需要先在 .env.local 配置模型。"],
  ["快照", "某次取得的输入数据的冻结副本。之后运行都用它，九立数据变了也不受影响。"],
  ["标注", "你对结果的纠错（比如「模型填错了」），可以导出用来改进提示词。"],
];

export function GuideDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-100/25 p-6 backdrop-blur-[2px]" role="dialog" aria-label="新手指南">
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-5 py-3">
          <span className="font-semibold">新手指南：三步跑通</span>
          <Btn className="ml-auto" onClick={onClose} data-testid="guide-close">
            开始使用
          </Btn>
        </div>
        <div className="overflow-auto px-5 py-4 text-[13px] leading-6 text-ink-200">
          <ol className="space-y-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink-100 text-[12px] font-semibold text-white">{i + 1}</span>
                <div>
                  <div className="font-semibold text-ink-100">{s.title}</div>
                  <div className="text-ink-400">{s.desc}</div>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-5 mb-2 text-[12px] font-semibold text-ink-400">看不懂的词</div>
          <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2">
            {TERMS.map(([term, desc]) => (
              <div key={term} className="contents">
                <dt className="font-medium text-ink-100">{term}</dt>
                <dd className="text-ink-400">{desc}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-5 text-[12px] text-ink-400">更详细的说明见项目里的 docs/使用说明.md。随时可以点顶栏的「新手指南」再打开这份说明。</p>
        </div>
      </div>
    </div>
  );
}
