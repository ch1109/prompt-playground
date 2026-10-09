# Fixture 说明

| 目录 | 来源 | 性质 |
|---|---|---|
| `jiuli-v2.0/` | 规格包原样保留（从 v2.0 Prompt 文档"输出契约示例"提取） | **结构演示**，不是模型输出，不是业务样本 |
| `jiuli-v3.0/<样本>/` | 复制自 `九立demo/demo-generated/real-calibration/`（P1~P4 request/response + provenance） | **真实录制的模型输出**（gpt-5.6 系列，见各目录 provenance.json），**不是 Gold 标准答案**，不能据此宣称准确率 |
| `constructed/` | `scripts/build-constructed-fixtures.mjs` 生成 | **人工构造**的负例与场景，不是真实单证 |

重新生成构造样本：`node scripts/build-constructed-fixtures.mjs`
