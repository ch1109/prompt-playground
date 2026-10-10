"use client";
import { Btn } from "@/components/ui";

const STEPS = [
  { title: "选输入", desc: "顶部默认是「结果检查」模式。点「更换输入」，上传 PDF、Excel、图片或整个文件夹，也可以选一个示例。九立的 P1～P4 在左侧「九立预设」里。" },
  { title: "写提示词、运行", desc: "点「编辑提示词」（或顶部「提示词调试」）写下你要 AI 做什么，再点右上角「运行模型」。扫描件和图片会让模型直接看图。" },
  { title: "检查结果", desc: "第一行告诉你运行是否成功、有几条结果、准确性能不能评测。点任意字段，右侧显示来源原文，可以一键标「这个值对 / 这个值错」；改完提示词用「版本对比」看前后差别。" },
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
