// Provider metadata is display text, never markup, a logo URL or brand proof.
export default function McpClientIdentity({ client }) {
  return (
    <div className="mcp-client">
      <strong>{client.name || client.id}</strong>
      <small>
        {client.name_verified
          ? "客户端元数据名称"
          : "客户端提供的名称，未经验证"}
      </small>
      <dl className="mcp-facts">
        <div>
          <dt>客户端 ID</dt>
          <dd>{client.id}</dd>
        </div>
        {client.domain && (
          <div>
            <dt>元数据域名</dt>
            <dd>{client.domain}</dd>
          </div>
        )}
        {client.redirect_host && (
          <div>
            <dt>回调主机</dt>
            <dd>{client.redirect_host}</dd>
          </div>
        )}
      </dl>
      {client.redirect_is_loopback && (
        <p className="mcp-warning">
          授权结果将返回本机应用。请确认这是你主动连接的客户端。
        </p>
      )}
    </div>
  );
}
