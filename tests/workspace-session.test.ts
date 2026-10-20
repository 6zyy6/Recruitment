import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

// Execute the component's real hooks and handlers without mounting its large JSX
// tree. Deferred HTTP responses exercise the same closures used by the buttons.
const file = new URL("../components/recruitment/Workspace.tsx", import.meta.url);
const source = ts.createSourceFile(file.pathname, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "Workspace")!;
const body = component.body!;
const renderStart = body.statements.find(node => ts.isIfStatement(node))!;
const childHandlers: string[] = [];
let logoutHandler = "";
function visit(node: ts.Node) {
  if (ts.isJsxAttribute(node) && node.name.getText(source) === "onSnapshot" && node.initializer && ts.isJsxExpression(node.initializer))
    childHandlers.push(node.initializer.expression!.getText(source));
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "button" &&
    node.children.some(child => ts.isJsxText(child) && child.text.includes("退出演示账号"))) {
    const handler = node.openingElement.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(source) === "onClick") as ts.JsxAttribute;
    logoutHandler = (handler.initializer as ts.JsxExpression).expression!.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(component);
assert.ok(logoutHandler);
assert.ok(childHandlers.length >= 2);
const setup = source.text.slice(body.getStart(source) + 1, renderStart.getStart(source));
const runnable = ts.transpileModule(`${setup}\nreturn { refresh, login, action, logout: ${logoutHandler}, children: [${childHandlers.join(",")}], snapshot, error, busy, loading };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const makeWorkspace = new Function("useState", "useRef", "useEffect", "useEffectEvent", "useMemo", "getMetrics", "fetch", runnable);

type View = { user: { id: string; role: string }; state: { revision: number } };
type Workspace = {
  refresh: () => Promise<boolean>;
  login: (userId: string) => Promise<void>;
  logout: () => Promise<void>;
  action: (name: string) => Promise<unknown>;
  children: Array<(next: View) => void>;
  snapshot: View | null;
  error: string;
  busy: boolean;
  loading: boolean;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const view = (userId: string, revision = 10): View => ({
  user: { id: userId, role: userId === "hr" ? "hr" : "manager" }, state: { revision },
});
function harness() {
  const slots: unknown[] = [], effects: Array<() => unknown> = [];
  let cursor = 0, cookieUser: string | null = null;
  let intercept: ((url: string, init?: RequestInit) => Promise<Response> | undefined) | undefined;
  const fetcher = async (url: string, init?: RequestInit) => {
    const held = intercept?.(url, init);
    if (held) return held;
    if (url === "/api/session") {
      if (init?.method === "POST") cookieUser = JSON.parse(String(init.body)).userId;
      if (init?.method === "DELETE") cookieUser = null;
      return Response.json({ user: cookieUser ? view(cookieUser).user : null, users: [] });
    }
    assert.equal(url, "/api/recruitment");
    return Response.json(view(cookieUser!, cookieUser === "hr" ? 10 : 11));
  };
  function render(): Workspace {
    cursor = 0;
    effects.length = 0;
    return makeWorkspace(
      (initial: unknown) => {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
        return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
      },
      (initial: unknown) => {
        const index = cursor++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      },
      (effect: () => unknown) => { effects.push(effect); },
      (callback: unknown) => callback,
      (callback: () => unknown) => callback(),
      () => null,
      fetcher,
    ) as Workspace;
  }
  return {
    render, effects,
    setIntercept: (handler?: typeof intercept) => { intercept = handler; },
    setCookie: (userId: string) => { cookieUser = userId; },
    cookie: () => cookieUser,
    async signedIn() { await render().login("hr"); return render(); },
  };
}

test("a late refresh cannot restore the previous role after account switching", async () => {
  const app = harness(), hr = await app.signedIn(), held = deferred<Response>();
  app.setIntercept((url, init) => url === "/api/recruitment" && init?.method === "GET" ? held.promise : undefined);
  const refresh = hr.refresh();
  app.setIntercept();
  await app.render().login("manager");
  held.resolve(Response.json(view("hr", 10)));
  await refresh;
  assert.equal(app.cookie(), "manager");
  assert.equal(app.render().snapshot?.user.id, "manager");
});

test("a late refresh cannot reopen the workspace after successful logout", async () => {
  const app = harness(), hr = await app.signedIn(), held = deferred<Response>();
  app.setIntercept((url) => url === "/api/recruitment" ? held.promise : undefined);
  const refresh = hr.refresh();
  await app.render().logout();
  held.resolve(Response.json(view("hr")));
  await refresh;
  assert.equal(app.cookie(), null);
  assert.equal(app.render().snapshot, null);
});

test("reversed refresh completion never replaces a newer revision", async () => {
  const app = harness(), hr = await app.signedIn(), older = deferred<Response>(), newer = deferred<Response>();
  let reads = 0;
  app.setIntercept(() => ++reads === 1 ? older.promise : newer.promise);
  const first = hr.refresh(), second = hr.refresh();
  newer.resolve(Response.json(view("hr", 12)));
  await second;
  older.resolve(Response.json(view("hr", 11)));
  await first;
  assert.equal(app.render().snapshot?.state.revision, 12);
});

test("late action responses and child snapshots cannot overwrite another session, even after switching back", async () => {
  const app = harness(), hr = await app.signedIn(), held = deferred<Response>();
  app.setIntercept((url, init) => url === "/api/recruitment" && init?.method === "POST" ? held.promise : undefined);
  const action = hr.action("ensure_resume_review").catch(() => undefined);
  app.setIntercept();
  await app.render().login("manager");
  held.resolve(Response.json(view("hr", 100)));
  await action;
  for (const receive of hr.children) receive(view("hr", 101));
  assert.equal(app.render().snapshot?.user.id, "manager");
  await app.render().login("hr");
  for (const receive of hr.children) receive(view("hr", 102));
  assert.equal(app.render().snapshot?.state.revision, 10);
});

test("callbacks rendered while an account switch is pending cannot acquire the new session", async () => {
  const app = harness(), post = deferred<Response>();
  await app.signedIn();
  app.setIntercept((url, init) => url === "/api/session" && init?.method === "POST" ? post.promise : undefined);
  const switching = app.render().login("manager");
  const duringSwitch = app.render().children;
  app.setIntercept();
  // The deferred response represents a committed login; update the mock cookie
  // before the component requests the manager's workspace.
  app.setCookie("manager");
  post.resolve(Response.json({ user: view("manager").user, users: [] }));
  await switching;
  for (const receive of duringSwitch) receive(view("hr", 100));
  assert.equal(app.render().snapshot?.user.id, "manager");
});

test("initial session reads cannot overwrite a login that finishes first", async () => {
  const app = harness(), initial = deferred<Response>();
  app.setCookie("hr");
  app.render();
  app.setIntercept(url => url === "/api/recruitment" ? initial.promise : undefined);
  app.effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  app.setIntercept();
  await app.render().login("manager");
  initial.resolve(Response.json(view("hr")));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.render().snapshot?.user.id, "manager");
  assert.equal(app.render().loading, false);
});

for (const failure of ["http", "network"] as const) {
  test(`logout ${failure} failure preserves the signed-in view and permits retry and login`, async () => {
    const app = harness();
    await app.signedIn();
    app.setIntercept((url, init) => url === "/api/session" && init?.method === "DELETE"
      ? failure === "http" ? Promise.resolve(Response.json({ message: "会话暂时无法删除" }, { status: 500 })) : Promise.reject(new Error("网络已断开"))
      : undefined);
    await app.render().logout();
    assert.equal(app.cookie(), "hr");
    assert.equal(app.render().snapshot?.user.id, "hr");
    assert.ok(app.render().error);
    assert.equal(app.render().busy, false);
    app.setIntercept();
    await app.render().logout();
    assert.equal(app.render().snapshot, null);
    await app.render().login("manager");
    assert.equal(app.render().snapshot?.user.id, "manager");
  });
}

test("a successful account switch followed by a failed workspace read cannot retain the previous role", async () => {
  const app = harness();
  await app.signedIn();
  app.setIntercept(url => url === "/api/recruitment"
    ? Promise.resolve(Response.json({ message: "工作台暂不可用" }, { status: 503 })) : undefined);
  await app.render().login("manager");
  assert.equal(app.cookie(), "manager");
  assert.equal(app.render().snapshot, null);
  assert.ok(app.render().error);
  app.setIntercept();
  await app.render().login("manager");
  assert.equal(app.render().snapshot?.user.id, "manager");
});
