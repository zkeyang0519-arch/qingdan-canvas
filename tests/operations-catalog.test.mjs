import test from "node:test";
import assert from "node:assert/strict";
import {
  addDeployment,
  addProduct,
  addServer,
  createInitialOpsState,
  deleteProduct,
  deleteServer,
  groupDeploymentsByRole,
  parseOpsState,
  serializeOpsState,
  updateServer,
} from "../src/ops/model.js";

test("operations catalog keeps products, servers, and role-grouped deployments", () => {
  let state = createInitialOpsState();
  state = addProduct(state, { name: "轻单", owner: "平台组" });
  state = addServer(state, { name: "prod-api-01", environment: "production" });
  state = addDeployment(state, {
    productId: state.products[0].id,
    serverId: state.servers[0].id,
    environment: "production",
    role: "API",
  });

  const groups = groupDeploymentsByRole(state, state.products[0].id);
  assert.equal(state.products[0].name, "轻单");
  assert.equal(state.servers[0].name, "prod-api-01");
  assert.deepEqual(groups.map((group) => group.role), ["API"]);
});

test("deleting a product or server cascades linked deployments and ops tasks", () => {
  let state = createInitialOpsState();
  state = addProduct(state, { name: "轻单" });
  state = addServer(state, { name: "prod-api-01" });
  state = addDeployment(state, {
    productId: state.products[0].id,
    serverId: state.servers[0].id,
    environment: "production",
    role: "API",
  });
  const productId = state.products[0].id;
  const serverId = state.servers[0].id;
  const deploymentId = state.deployments[0].id;
  state = {
    ...state,
    tasks: [
      { id: "task-product", text: "产品待办", targetType: "product", targetId: productId, completed: false, createdAt: new Date().toISOString() },
      { id: "task-server", text: "服务器待办", targetType: "server", targetId: serverId, completed: false, createdAt: new Date().toISOString() },
      { id: "task-deployment", text: "部署待办", targetType: "deployment", targetId: deploymentId, completed: false, createdAt: new Date().toISOString() },
    ],
  };

  const afterProduct = deleteProduct(state, productId);
  assert.equal(afterProduct.products.length, 0);
  assert.equal(afterProduct.deployments.length, 0);
  assert.deepEqual(afterProduct.tasks.map((task) => task.id), ["task-server"]);

  const afterServer = deleteServer(state, serverId);
  assert.equal(afterServer.servers.length, 0);
  assert.equal(afterServer.deployments.length, 0);
  assert.deepEqual(afterServer.tasks.map((task) => task.id), ["task-product"]);
});

test("服务器 DDL 单日和区间在保存、重新读取和修改资料后保留", () => {
  let state = addServer(createInitialOpsState(), {
    name: "prod-api-01",
    dueAt: "2028-02-29T04:30:00.000Z",
    dueStartAt: "2028-02-27T16:00:00.000Z",
  });
  state = parseOpsState(serializeOpsState(state));
  assert.equal(state.servers[0].dueAt, "2028-02-29T04:30:00.000Z");
  assert.equal(state.servers[0].dueStartAt, "2028-02-27T16:00:00.000Z");
  state = updateServer(state, state.servers[0].id, { name: "renamed" });
  assert.equal(state.servers[0].dueAt, "2028-02-29T04:30:00.000Z");
  state = updateServer(state, state.servers[0].id, { dueStartAt: null });
  assert.equal(state.servers[0].dueStartAt, null);
  assert.equal(state.servers[0].dueAt, "2028-02-29T04:30:00.000Z");
  state = updateServer(state, state.servers[0].id, { dueAt: null, dueStartAt: null });
  assert.equal(parseOpsState(serializeOpsState(state)).servers[0].dueAt, null);
});

test("服务器拒绝无效 DDL、反向区间及没有结束日期的区间", () => {
  for (const dates of [
    { dueAt: "2028-02-30T00:00:00.000Z" },
    { dueAt: "2028-02-29" },
    { dueAt: null, dueStartAt: "2028-02-28T00:00:00.000Z" },
    { dueAt: "2028-02-28T00:00:00.000Z", dueStartAt: "2028-02-29T00:00:00.000Z" },
  ]) assert.throws(() => addServer(createInitialOpsState(), { name: "server", ...dates }), /截止|日期|区间/);
  const legacy = addServer(createInitialOpsState(), { name: "旧服务器" });
  delete legacy.servers[0].dueAt;
  delete legacy.servers[0].dueStartAt;
  assert.equal(parseOpsState(serializeOpsState(legacy)).servers[0].name, "旧服务器");
});
