import { describe, expect, it } from "bun:test";
import { CURATED_MODELS, runInteractiveModelPicker } from "../../src/tui/interactive-model-picker";
import { Readable, Writable } from "node:stream";

describe("interactive-model-picker", () => {
  it("curated models contain top OpenAI, Anthropic, Google, and Ollama models", () => {
    const providers = new Set(CURATED_MODELS.map((m) => m.provider));
    expect(providers.has("openai")).toBe(true);
    expect(providers.has("anthropic")).toBe(true);
    expect(providers.has("google")).toBe(true);
    expect(providers.has("ollama")).toBe(true);
  });

  it("allows selecting a curated model from standard input", async () => {
    let activeModel = "chat-latest";
    const fakeRuntime: any = {
      model: "chat-latest",
      providerName: "openai",
      setModel: async (target: string) => {
        activeModel = target;
        return target;
      },
    };

    const notices: string[] = [];
    const fakeRenderer = {
      notice: (msg: string) => notices.push(msg),
    };

    // Simulate user entering "1" (GPT-4o)
    const stdin = Readable.from(["1\n"]);
    let out = "";
    const stdout = new Writable({
      write(chunk, _, cb) {
        out += chunk.toString();
        cb();
      },
    });

    const res = await runInteractiveModelPicker(fakeRuntime, fakeRenderer, { stdin, stdout });
    expect(res.switched).toBe(true);
    expect(res.model).toBe("gpt-4o");
    expect(activeModel).toBe("gpt-4o");
  });

  it("handles cancel gracefully with 0", async () => {
    const fakeRuntime: any = {
      model: "chat-latest",
      providerName: "openai",
      setModel: async () => {},
    };

    const notices: string[] = [];
    const fakeRenderer = {
      notice: (msg: string) => notices.push(msg),
    };

    const stdin = Readable.from(["0\n"]);
    const stdout = new Writable({
      write(_, __, cb) {
        cb();
      },
    });

    const res = await runInteractiveModelPicker(fakeRuntime, fakeRenderer, { stdin, stdout });
    expect(res.switched).toBe(false);
    expect(notices).toContain("model unchanged");
  });
});
