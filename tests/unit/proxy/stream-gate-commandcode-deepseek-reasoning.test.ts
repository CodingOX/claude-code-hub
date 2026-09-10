/**
 * 现场回归：CommandCode 的 DeepSeek 套餐（provider 注册为 openai-compatible）。
 *
 * 生产症状（修复前）：
 *   [CircuitBreaker] Provider 180 failure recorded:
 *   "Stream content gate rejected upstream before first valid content (prebuffer_overflow)"
 *   -> 客户端拿到 503「所有供应商暂时不可用」，同时健康供应商被错误累积熔断。
 *
 * 根因（本次实测确认，非推断）：
 *   CommandCode 的 DeepSeek 把推理内容放在 `delta.reasoning` + `delta.reasoning_details`，
 *   而 openai-chat 的内容规则只认 DeepSeek 官方的 `delta.reasoning_content`。
 *   于是整段「思考前缀」全部落进中性帧分支，在第 65 帧撞穿默认决策预算（64）——
 *   而 reasoning_tokens 实测可达 235，远超预算，健康上游被误判成中性帧洪泛。
 *
 * 夹具 `commandcode-deepseek-reasoning-only-prefix.sse` 是从
 *   https://api.commandcode.ai/provider/v1/chat/completions
 * 实抓的真实流（stream:true）前 70 帧，逐字节保留，未做任何改写。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyFrame } from "@/app/v1/_lib/proxy/stream-gate/frame-classifier";
import {
  runStreamContentGate,
  StreamPrecommitError,
} from "@/app/v1/_lib/proxy/stream-gate/stream-content-gate";

const FIXTURE_PATH = resolve(
  process.cwd(),
  "tests/fixtures/proxy/commandcode-deepseek-reasoning-only-prefix.sse"
);
/** 实抓的真实 SSE 字节流（前 70 帧） */
const RAW_STREAM = readFileSync(FIXTURE_PATH, "utf-8");
/** 夹具内的完整帧（以空行分隔） */
const FIXTURE_FRAMES = RAW_STREAM.split("\n\n").filter((frame) => frame.length > 0);
const REASONING_FRAME = FIXTURE_FRAMES[1] as string;
const FIRST_FRAME = FIXTURE_FRAMES[0] as string;

/** 按任意网络切分喂入，验证门控不依赖 chunk 边界 */
function readerFromText(text: string, sliceSize: number): ReadableStreamDefaultReader<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + sliceSize));
      offset += sliceSize;
    },
  }).getReader();
}

const GATE_OPTIONS = {
  family: "openai-chat" as const,
  providerId: 180,
  providerName: "CommandCode_OC",
  prebufferEventCap: 64,
  prebufferByteCap: 10 * 1024 * 1024,
};

describe("CommandCode DeepSeek 推理前缀（实抓流回归）", () => {
  it("夹具规模证明修复前必然溢出：70 帧 > 64 帧决策预算", () => {
    // 这条断言是「修复前会挂」的量化依据：中性帧数一旦越过预算就走 prebuffer_overflow。
    expect(FIXTURE_FRAMES.length).toBe(70);
    expect(FIXTURE_FRAMES.length).toBeGreaterThan(64);
  });

  it("上游用扩展字段携带推理内容，而不是 DeepSeek 官方的 reasoning_content", () => {
    // 第 2 帧是首个推理帧：字段名是 reasoning / reasoning_details。
    expect(REASONING_FRAME).toContain('"reasoning":"');
    expect(REASONING_FRAME).toContain('"reasoning_details":');
    expect(REASONING_FRAME).not.toContain("reasoning_content");
  });

  it("分类器把实抓推理帧判为 content（修复前是 neutral，这才是溢出的直接原因）", () => {
    // 首帧只带 role，按设计仍是中性（结构元数据不是内容信号）。
    expect(classifyFrame("openai-chat", null, FIRST_FRAME.replace(/^data:\s*/, ""))).toBe(
      "neutral"
    );

    // 其余 69 帧全部是推理内容：修复前每一帧都落进中性分支，第 65 帧撞穿预算。
    for (const frame of FIXTURE_FRAMES.slice(1)) {
      const data = frame.replace(/^data:\s*/, "");
      expect(classifyFrame("openai-chat", null, data), frame.slice(0, 120)).toBe("content");
    }
  });

  it("门控在第二个帧就提交，不再判死请求（核心回归）", async () => {
    const result = await runStreamContentGate(readerFromText(RAW_STREAM, 512), {
      ...GATE_OPTIONS,
      captureCommitMarker: true,
    });

    // 修复前：committed=false + gateReason "prebuffer_overflow" -> 503 + 熔断计次
    expect(result.committed).toBe(true);
    if (!result.committed) {
      // 失败时打印实际原因，便于夹具漂移时快速定位
      const reason =
        result.error instanceof StreamPrecommitError
          ? result.error.gateReason
          : result.error.message;
      throw new Error(`门控仍然拒绝了这条真实流: ${reason}`);
    }

    // 第 1 帧 role 为中性，第 2 帧推理即内容 -> 提交发生在第 2 帧，且不是 fail-open。
    expect(result.commitMarker?.frameIndex).toBe(2);
    expect(result.commitMarker?.prebufferOverflow).toBeUndefined();
    // 提交后流未结束：后续正文帧仍在 reader 上，由调用方继续透传。
    expect(result.readerDone).toBe(false);
  });

  it("已缓冲前缀逐字节完整，没有丢帧（thinking 内容必须照原样到客户端）", async () => {
    const result = await runStreamContentGate(readerFromText(RAW_STREAM, 333), {
      ...GATE_OPTIONS,
    });
    expect(result.committed).toBe(true);
    if (!result.committed) return;

    const prefix = new TextDecoder().decode(
      result.prefixChunks.length === 1
        ? result.prefixChunks[0]
        : Buffer.concat(result.prefixChunks.map((chunk) => Buffer.from(chunk)))
    );
    // 前缀交出「提交帧所在的整个网络 chunk」，因此可能停在帧中间——
    // 这不是丢字节：剩余尾字节仍挂在 reader 上，由调用方按序继续透传。
    // 断言它是原始流的字节前缀，且至少覆盖到提交帧结束。
    expect(RAW_STREAM.startsWith(prefix)).toBe(true);
    expect(prefix).toContain(FIRST_FRAME);
    expect(prefix).toContain(REASONING_FRAME);
    // 推理正文原样可见——客户端不应因为门控而丢掉思考内容。
    expect(prefix).toContain("我们需要");
  });

  it("推理长度远超决策预算时依然正常（实测 reasoning_tokens 可达 235）", async () => {
    // 复刻极端形态：235 帧纯推理后才出现正文，帧数远超 64 帧预算。
    const reasoningFrames = Array.from(
      { length: 235 },
      (_, index) =>
        `data: {"choices":[{"index":0,"delta":{"reasoning":"思考 ${index}","reasoning_details":[{"type":"reasoning.text","text":"思考 ${index}"}]},"finish_reason":null}]}\n\n`
    );
    const reader = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = reasoningFrames.shift();
        if (!next) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(next));
      },
    }).getReader();

    const result = await runStreamContentGate(reader, { ...GATE_OPTIONS });
    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(result.framesSeen).toBe(1);
  });
});
