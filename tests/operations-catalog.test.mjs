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
