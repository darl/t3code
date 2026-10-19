import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type EditorId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { createElement, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../test/render.tsx";
import type { RemoteOpenResolution } from "./remoteOpen";
import { useOpenInPreferredEditor } from "./editorPreferences";

const mocks = vi.hoisted(() => ({
  allowed: new Set<string>(),
  remote: { state: { mode: "local-exec" }, isResolved: true } as RemoteOpenResolution,
  editors: ["vscode"] as readonly EditorId[],
  openLocal: vi.fn(),
  openRemote: vi.fn(),
  markHintSeen: vi.fn(),
}));
vi.mock("./state/shell", () => ({ shellEnvironment: { openInEditor: {} } }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => mocks.openLocal }));
vi.mock("./remoteOpen", () => ({
  useRemoteOpenResolution: () => mocks.remote,
  useRemoteCapableEditors: () => mocks.editors,
  useRemoteOpenHint: () => [false, mocks.markHintSeen],
  openRemoteEditorUrl: mocks.openRemote,
}));

vi.mock("./state/session", () => ({
  readEnvironmentScope: (id: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && mocks.allowed.has(id),
}));

const environmentId = EnvironmentId.make("remote-server");
const path = "/home/darl/project/file.ts:12:3";
function makeOpener(
  availableEditors: readonly EditorId[],
  id: EnvironmentId | null = environmentId,
) {
  let open: ReturnType<typeof useOpenInPreferredEditor> | undefined;
  function Probe() {
    const opener = useOpenInPreferredEditor(id, availableEditors);
    useEffect(() => {
      open = opener;
    }, [opener]);
    return null;
  }
  return {
    element: createElement(Probe),
    open: (path: string) => {
      if (!open) throw new Error("Editor opener was not mounted");
      return open(path);
    },
  };
}

function setup() {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.allowed.clear();
  mocks.allowed.add(environmentId);
  mocks.remote = { state: { mode: "local-exec" }, isResolved: true };
  mocks.editors = ["vscode"];
  mocks.openLocal.mockResolvedValue(AsyncResult.success(undefined));
  mocks.openRemote.mockResolvedValue(true);
  return { [Symbol.dispose]: () => localStorage.clear() };
}

describe("opening files in the preferred editor", () => {
  it("checks revocation and regrant when a retained editor callback is invoked", async () => {
    using _state = setup();
    const probe = makeOpener(["vscode"]);
    await using _screen = await render(probe.element);
    const open = probe.open;
    mocks.allowed.delete(environmentId);
    const result = await open(path);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.squash(result.cause)).toBeInstanceOf(EnvironmentAuthorizationError);
    }
    expect(mocks.openLocal).not.toHaveBeenCalled();
    mocks.allowed.add(environmentId);
    expect(await open(path)).toMatchObject({ _tag: "Success", value: "vscode" });
  });

  it("does not use another environment's grant", async () => {
    using _state = setup();
    mocks.allowed.delete(environmentId);
    mocks.allowed.add("another-environment");
    const probe = makeOpener(["vscode"]);
    await using _screen = await render(probe.element);
    expect((await probe.open(path))._tag).toBe("Failure");
    expect(mocks.openLocal).not.toHaveBeenCalled();
    expect(mocks.openRemote).not.toHaveBeenCalled();
  });
  it("opens remote files locally over SSH even when the server has no editors", async () => {
    using _state = setup();
    mocks.remote = {
      state: { mode: "remote-links", host: { kind: "ssh-alias", host: "darl" } },
      isResolved: true,
    };
    const probe = makeOpener([]);
    await using _screen = await render(probe.element);
    const result = await probe.open(path);
    expect(result).toMatchObject({ _tag: "Success", value: "vscode" });
    expect(mocks.openRemote).toHaveBeenCalledWith(
      "vscode://vscode-remote/ssh-remote+darl/home/darl/project/file.ts%3A12%3A3",
    );
    expect(mocks.openLocal).not.toHaveBeenCalled();
    expect(mocks.markHintSeen).toHaveBeenCalledOnce();
  });

  it("uses the viewing machine's editors instead of the server's editors", async () => {
    using _state = setup();
    mocks.remote = {
      state: { mode: "remote-links", host: { kind: "tailscale", host: "darl.tail.net" } },
      isResolved: true,
    };
    mocks.editors = ["cursor"];
    const probe = makeOpener(["idea"]);
    await using _screen = await render(probe.element);
    const result = await probe.open("/home/darl/my project/file.ts");
    expect(result).toMatchObject({ _tag: "Success", value: "cursor" });
    expect(mocks.openRemote).toHaveBeenCalledWith(
      "cursor://vscode-remote/ssh-remote+darl.tail.net/home/darl/my%20project/file.ts",
    );
    expect(mocks.openLocal).not.toHaveBeenCalled();
  });

  it("keeps local file opening on the environment", async () => {
    using _state = setup();
    const probe = makeOpener(["vscode"]);
    await using _screen = await render(probe.element);
    const result = await probe.open(path);
    expect(result).toMatchObject({ _tag: "Success", value: "vscode" });
    expect(mocks.openLocal).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: path, editor: "vscode" },
    });
    expect(mocks.openRemote).not.toHaveBeenCalled();
  });

  it.each([
    { state: { mode: "remote-unavailable" }, isResolved: true },
    { state: { mode: "local-exec" }, isResolved: false },
  ] satisfies RemoteOpenResolution[])(
    "does not execute on the server without a resolved route: %j",
    async (remote) => {
      using _state = setup();
      mocks.remote = remote;
      const probe = makeOpener(["vscode"]);
      await using _screen = await render(probe.element);
      const result = await probe.open(path);
      expect(result._tag).toBe("Failure");
      expect(mocks.openLocal).not.toHaveBeenCalled();
      expect(mocks.openRemote).not.toHaveBeenCalled();
    },
  );

  it("reports a refused remote link as a failure", async () => {
    using _state = setup();
    mocks.remote = {
      state: { mode: "remote-links", host: { kind: "ssh-alias", host: "darl" } },
      isResolved: true,
    };
    mocks.openRemote.mockResolvedValue(false);
    const probe = makeOpener([]);
    await using _screen = await render(probe.element);
    const result = await probe.open(path);
    expect(result._tag).toBe("Failure");
    expect(mocks.markHintSeen).not.toHaveBeenCalled();
    expect(mocks.openLocal).not.toHaveBeenCalled();
  });

  it("requires an environment before opening a file", async () => {
    using _state = setup();
    const probe = makeOpener(["vscode"], null);
    await using _screen = await render(probe.element);
    const result = await probe.open(path);
    expect(result._tag).toBe("Failure");
    expect(mocks.openLocal).not.toHaveBeenCalled();
    expect(mocks.openRemote).not.toHaveBeenCalled();
  });
});
