"use client";
import { Btn } from "@/components/ui";

const STEPS = [
  { title: "写提示词", desc: "左侧默认是「通用提示词」，在「提示词」页写下你要 AI 做什么。九立的 P1～P4 在左侧「九立预设」里。" },
  { title: "上传文件", desc: "「输入 → 上传文件」把 PDF、Excel、图片拖进来，也可以拖整个文件夹。扫描件和图片会让模型直接看图。" },
  { title: "点「运行模型」", desc: "结果显示在右侧「结果」页；模型回答 JSON 时按树展示，回答文字时按文本展示。想先不花钱看看效果，可以在「示例」里点「仅渲染」。" },
];

const TERMS = [
  ["提示词", "发给 AI 的指令。「通用提示词」什么任务都能写；「九立预设」是四种九立任务。"],
  ["示例", "现成的输入和输出，用来试看效果，不需要任何配置。"],
  ["仅渲染", "离线把已有输出整理成表格，不调用模型，不花钱。"],
  ["运行模型", "真正调用 AI，会产生费用。需要先在 .env.local 配置模型。"],
  ["输入", "上传的文件或导入的数据会存成一份固定副本，之后每次运行都用它，方便前后比较。"],
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
