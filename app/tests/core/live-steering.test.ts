import { describe, expect, test } from "bun:test";
import { InterjectionBuffer } from "../../src/core/interjection";
import { interjectionLiveSteeringQueue, LiveSteeringChannel } from "../../src/core/live-steering";

describe("LiveSteeringChannel", () => {
  test("claim accept records steering in queue order", async () => {
    const buffer = new InterjectionBuffer();
    buffer.push("first");
    buffer.push("second");
    const channel = new LiveSteeringChannel(interjectionLiveSteeringQueue(buffer));
    const claim = await channel.claim(new AbortController().signal);
    expect(claim).toBeDefined();
    expect(claim!.messages).toEqual(["first", "second"]);
    claim!.accept();
    expect(channel.accepted.map((e) => e.text)).toEqual(["first", "second"]);
    expect(channel.deferred).toHaveLength(0);
    expect(buffer.isEmpty()).toBe(true);
  });

  test("reject defers and blocks later live claims until restored", async () => {
    const buffer = new InterjectionBuffer();
    buffer.push("steer-a");
    const channel = new LiveSteeringChannel(interjectionLiveSteeringQueue(buffer));
    const claim = await channel.claim(new AbortController().signal);
    claim!.reject();
    expect(channel.deferred.map((e) => e.text)).toEqual(["steer-a"]);
    buffer.push("steer-b");
    // Deferred blocks live delivery so user order is preserved.
    expect(await channel.claim(new AbortController().signal)).toBeUndefined();
    channel.restoreDeferred(buffer);
    expect(buffer.drainAll().map((e) => e.text)).toEqual(["steer-a", "steer-b"]);
  });

  test("aborted signal yields no claim", async () => {
    const buffer = new InterjectionBuffer();
    buffer.push("late");
    const channel = new LiveSteeringChannel(interjectionLiveSteeringQueue(buffer));
    const ctl = new AbortController();
    ctl.abort();
    expect(await channel.claim(ctl.signal)).toBeUndefined();
    expect(buffer.len()).toBe(1);
  });
});
