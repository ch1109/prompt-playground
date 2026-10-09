// 模型调用失败时给用户看的中文解释：先说原因与下一步，服务商原文另行折叠展示。

export interface ErrorHint {
  title: string;
  advice: string;
}

const ENV_HINT = "修改项目根目录 .env.local 后需重启服务";

const BY_CODE: Record<string, ErrorHint> = {
  MODEL_HTTP_400: { title: "服务商拒绝了请求内容", advice: "常见原因：参数不被该模型支持（如 max_tokens 过大）或请求过长。可调小 max_tokens 或检查请求预览后重试。" },
  MODEL_HTTP_401: { title: "API 密钥无效或已过期", advice: `检查 MODEL_API_KEY 是否正确、是否仍有效（${ENV_HINT}）。` },
  MODEL_HTTP_403: { title: "API 密钥没有调用该模型的权限", advice: `确认密钥所属账号已开通该模型，或更换有权限的密钥（${ENV_HINT}）。` },
  MODEL_HTTP_404: { title: "找不到模型或接口地址", advice: `检查 MODEL_NAME 是否拼写正确（区分大小写）、MODEL_BASE_URL 是否为 OpenAI 兼容地址（${ENV_HINT}）。` },
  MODEL_HTTP_429: { title: "调用频率或额度超出限制", advice: "稍等片刻再重试；若持续出现，检查服务商账户的额度与限流设置。" },
  MODEL_TIMEOUT: { title: "模型在超时上限内没有返回", advice: "大样本或附带图片时可能较慢：可减少输入、调小 max_tokens，或调大 .env.local 中的 MODEL_TIMEOUT_MS 后重启。" },
  MODEL_NETWORK_ERROR: { title: "网络连接失败，没能连上服务商", advice: "检查本机网络、代理设置，以及 MODEL_BASE_URL 是否可以访问。" },
  MODEL_STREAM_BROKEN: { title: "响应传输中断", advice: "通常是网络波动，直接重试即可。" },
  MODEL_BAD_ENVELOPE: { title: "服务商返回的内容不完整或格式不对", advice: "可能是传输被截断或服务商异常，重试一次；持续出现请检查 MODEL_BASE_URL 是否为 OpenAI 兼容接口。" },
  MODEL_EMPTY_CONTENT: { title: "服务商返回了空内容", advice: "可能被服务商的内容审核拦截或模型异常，重试或换一个模型。" },
  MODEL_NOT_CONFIGURED: { title: "还没有配置模型", advice: `在 .env.local 填写 MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY（${ENV_HINT}）。` },
  INTERRUPTED: { title: "服务重启，调用被中断", advice: "这次没有取得结果，重新运行即可。" },
  RUN_INTERNAL_ERROR: { title: "Studio 内部处理出错", advice: "重试一次；若反复出现，请把下方详情发给开发排查。" },
};

export function explainModelError(code: string | undefined): ErrorHint {
  if (code && BY_CODE[code]) return BY_CODE[code];
  if (code && /^MODEL_HTTP_5\d\d$/.test(code)) return { title: "服务商暂时不可用", advice: "这是服务商一侧的故障，稍后重试；若持续出现，查看服务商状态页。" };
  return { title: "模型调用失败", advice: "重试一次；若反复出现，请查看下方详情。" };
}
