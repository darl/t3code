import { EnvironmentId, type EditorId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, createElement, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RemoteOpenResolution } from "./remoteOpen";
import { useOpenInPreferredEditor } from "./editorPreferences";

const mocks = vi.hoisted(() => ({
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

const environmentId = EnvironmentId.make("remote-server");
const path = "/home/darl/project/file.ts:12:3";
let renderer: ReactTestRenderer | undefined;

function mountOpener(
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
  act(() => {
    renderer = create(createElement(Probe));
  });
  if (!open) throw new Error("Editor opener was not mounted");
  return open;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.remote = { state: { mode: "local-exec" }, isResolved: true };
  mocks.editors = ["vscode"];
  mocks.openLocal.mockResolvedValue(AsyncResult.success(undefined));
  mocks.openRemote.mockResolvedValue(true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("opening files in the preferred editor", () => {
  it("opens remote files locally over SSH even when the server has no editors", async () => {
    mocks.remote = {
      state: { mode: "remote-links", host: { kind: "ssh-alias", host: "darl" } },
      isResolved: true,
    };
    const result = await mountOpener([])(path);
    expect(result).toMatchObject({ _tag: "Success", value: "vscode" });
    expect(mocks.openRemote).toHaveBeenCalledWith(
      "vscode://vscode-remote/ssh-remote+darl/home/darl/project/file.ts%3A12%3A3",
    );
    expect(mocks.openLocal).not.toHaveBeenCalled();
    expect(mocks.markHintSeen).toHaveBeenCalledOnce();
  });

  it("uses the viewing machine's editors instead of the server's editors", async () => {
    mocks.remote = {
      state: { mode: "remote-links", host: { kind: "tailscale", host: "darl.tail.net" } },
      isResolved: true,
    };
    mocks.editors = ["cursor"];
    const result = await mountOpener(["idea"])("/home/darl/my project/file.ts");
    expect(result).toMatchObject({ _tag: "Success", value: "cursor" });
    expect(mocks.openRemote).toHaveBeenCalledWith(
      "cursor://vscode-remote/ssh-remote+darl.tail.net/home/darl/my%20project/file.ts",
    );
    expect(mocks.openLocal).not.toHaveBeenCalled();
  });

  it("keeps local file opening on the environment", async () => {
    const result = await mountOpener(["vscode"])(path);
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
      mocks.remote = remote;
      const result = await mountOpener(["vscode"])(path);
      expect(result._tag).toBe("Failure");
      expect(mocks.openLocal).not.toHaveBeenCalled();
      expect(mocks.openRemote).not.toHaveBeenCalled();
    },
  );

  it("reports a refused remote link as a failure", async () => {
    mocks.remote = {
      state: { mode: "remote-links", host: { kind: "ssh-alias", host: "darl" } },
      isResolved: true,
    };
    mocks.openRemote.mockResolvedValue(false);
    const result = await mountOpener([])(path);
    expect(result._tag).toBe("Failure");
    expect(mocks.markHintSeen).not.toHaveBeenCalled();
    expect(mocks.openLocal).not.toHaveBeenCalled();
  });

  it("requires an environment before opening a file", async () => {
    const result = await mountOpener(["vscode"], null)(path);
    expect(result._tag).toBe("Failure");
    expect(mocks.openLocal).not.toHaveBeenCalled();
    expect(mocks.openRemote).not.toHaveBeenCalled();
  });
});
