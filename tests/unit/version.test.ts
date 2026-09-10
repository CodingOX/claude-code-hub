import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compareVersions, isVersionEqual, isVersionGreater, isVersionLess } from "@/lib/version";

describe("版本比较", () => {
  test("未注入构建版本时应读取 release VERSION", async () => {
    const original = process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    vi.resetModules();

    try {
      const { APP_VERSION } = await import("@/lib/version");
      const releaseVersion = readFileSync(join(process.cwd(), "VERSION"), "utf8").trim();
      expect(APP_VERSION).toBe(`v${releaseVersion}`);
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION;
      else process.env.NEXT_PUBLIC_APP_VERSION = original;
    }
  });

  test("构建版本环境变量没有 v 前缀时仍统一展示格式", async () => {
    const original = process.env.NEXT_PUBLIC_APP_VERSION;
    process.env.NEXT_PUBLIC_APP_VERSION = "0.9.4";
    vi.resetModules();

    try {
      const { APP_VERSION } = await import("@/lib/version");
      expect(APP_VERSION).toBe("v0.9.4");
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION;
      else process.env.NEXT_PUBLIC_APP_VERSION = original;
      vi.resetModules();
    }
  });

  test("应正确判断是否存在可升级版本（latest > current）", () => {
    expect(compareVersions("v0.3.0", "v0.3.33")).toBe(1);
    expect(compareVersions("v0.3.33", "v0.3.0")).toBe(-1);
    expect(compareVersions("v0.3.33", "v0.3.33")).toBe(0);
  });

  test("应正确处理预发布版本（stable > prerelease）", () => {
    expect(compareVersions("v1.2.3-beta.1", "v1.2.3")).toBe(1);
    expect(compareVersions("v1.2.3", "v1.2.3-beta.1")).toBe(-1);
  });

  test("应正确比较预发布标识（alpha < beta, alpha.1 < alpha.2）", () => {
    expect(compareVersions("v1.2.3-alpha", "v1.2.3-beta")).toBe(1);
    expect(compareVersions("v1.2.3-alpha.1", "v1.2.3-alpha.2")).toBe(1);
    expect(compareVersions("v1.2.3-alpha.2", "v1.2.3-alpha.10")).toBe(1);
  });

  test("应忽略构建元数据（+build）", () => {
    expect(compareVersions("v1.2.3+build.1", "v1.2.3+build.2")).toBe(0);
    expect(compareVersions("v1.2.3+build.2", "v1.2.3+build.1")).toBe(0);
  });

  test("无法解析的版本应 Fail Open（视为相等）", () => {
    expect(compareVersions("dev", "v1.0.0")).toBe(0);
    expect(isVersionLess("dev", "v1.0.0")).toBe(false);
    expect(isVersionGreater("dev", "v1.0.0")).toBe(false);
    expect(isVersionEqual("dev", "v1.0.0")).toBe(true);
  });
});

/**
 * 本仓库是 CodingOX fork，自行构建并发布镜像。
 *
 * 版本检查必须对比本仓库而不是上游 ding113，否则 Dashboard 会一直提示“发现新版本”，
 * 而它对比的其实是上游的 release，升级到上游版本对本仓库并不适用。
 *
 * 这组断言是 fork 本地补丁的护栏：合并上游时 version.ts 极易在冲突解决中被改回
 * ding113，导致提示静默复活。若要改回上游，请先确认是否真的想恢复该提示。
 */
describe("版本检查目标仓库", () => {
  test("应指向本仓库自身而不是上游 ding113", async () => {
    const { GITHUB_REPO } = await import("@/lib/version");
    expect(GITHUB_REPO).toEqual({ owner: "CodingOX", repo: "claude-code-hub" });
  });

  test("正式版本路径应查询本仓库的 releases/latest", async () => {
    const original = process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    vi.resetModules();

    const requested: string[] = [];
    // 与本地 VERSION 相同的 release 版本：应当判定为无更新
    const releaseVersion = readFileSync(join(process.cwd(), "VERSION"), "utf8").trim();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        requested.push(url);
        return new Response(
          JSON.stringify({
            tag_name: `v${releaseVersion}`,
            name: `v${releaseVersion}`,
            html_url: `https://github.com/CodingOX/claude-code-hub/releases/tag/v${releaseVersion}`,
            published_at: "2026-01-01T00:00:00Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    try {
      const { GET } = await import("@/app/api/version/route");
      const response = await GET();
      const data = await response.json();

      expect(requested[0]).toContain("repos/CodingOX/claude-code-hub/releases/latest");
      expect(data.hasUpdate).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      if (original === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION;
      else process.env.NEXT_PUBLIC_APP_VERSION = original;
    }
  });
});
