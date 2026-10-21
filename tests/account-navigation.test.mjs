import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Exercise the actual App handlers with deferred HTTP responses. No DOM is needed
// to reproduce the logout/login race; the component's JSX remains untouched.
const source = await readFile(
  new URL("../src/App.jsx", import.meta.url),
  "utf8",
);
const signature = "export default function App() {";
const logic = source.slice(
  source.indexOf(signature) + signature.length,
  source.indexOf("  if (initializing)"),
);
function appHarness(api, href = "https://test.invalid/") {
  const states = [];
  const location = { href };
  const history = {
    replaceState(_state, _title, path) {
      location.href = new URL(path, location.href).href;
    },
  };
  const fn = new Function(
    "useState",
    "useRef",
    "useEffect",
    "api",
    "setActiveAccount",
    "announceAccountChange",
    "inviteLink",
    "history",
    "location",
    `${logic}\nreturn {create,logout,authenticated,join};`,
  );
  const app = fn(
    (initial) => {
      const index = states.length;
      states.push(initial);
      return [
        initial,
        (value) => {
          states[index] = value;
        },
      ];
    },
    (value) => ({ current: value }),
    () => {},
    api,
    () => {},
    () => {},
    (id, token) => `https://test.invalid/?room=${id}#invite=${token}`,
    history,
    location,
  );
  return { app, states, location };
}
const userA = { id: "account-a", name: "A", username: "user_a" };
const userB = { id: "account-b", name: "B", username: "user_b" };

test("退出并登录另一账号后，前一账号延迟创建的画布与邀请不会进入新账号界面", async () => {
  let respond;
  const { app, states, location } = appHarness(async (path, options) => {
    if (path === "/api/rooms" && options?.method === "POST")
      return new Promise((resolve) => {
        respond = resolve;
      });
    return path === "/api/rooms" ? { rooms: [] } : { ok: true };
  });
  await app.authenticated({ user: userA });
  const pending = app.create({ preventDefault() {} });
  await app.logout();
  await app.authenticated({ user: userB });
  respond({
    room: { id: "private-a-room", name: "A only", role: "owner" },
    invite: "private-a-invite",
  });
  await pending;
  assert.ok(states.some((state) => state?.user?.id === userB.id));
  assert.equal(JSON.stringify(states).includes("private-a-"), false);
  assert.equal(location.href, "https://test.invalid/");
});

test("登录过程中的旧列表请求迟到时，不会用新账号继续兑换旧邀请", async () => {
  let respond,
    reads = 0;
  const requests = [];
  const { app, states } = appHarness(async (path) => {
    requests.push(path);
    if (path === "/api/rooms" && reads++ === 0)
      return new Promise((resolve) => {
        respond = resolve;
      });
    return path === "/api/rooms" ? { rooms: [] } : { ok: true };
  }, "https://test.invalid/?room=private-a-room#invite=private-a-invite");
  const pending = app.authenticated({ user: userA });
  await app.logout();
  await app.authenticated({ user: userB });
  respond({ rooms: [{ id: "private-a-room" }] });
  await pending;
  assert.equal(
    requests.some((path) => path.includes("/join")),
    false,
  );
  assert.equal(JSON.stringify(states).includes("private-a-room"), false);
});
