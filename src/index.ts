#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SwaggerLoader } from "./services/loader.js";
import { registerTools } from "./tools/index.js";

async function main() {
  const server = new Server(
    {
      name: "swagger-mcp-server",
      version: "2.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 初始化服务加载器
  const loader = new SwaggerLoader();
  
  // 注册工具
  registerTools(server, loader);

  // 错误处理
  server.onerror = (error: unknown) => console.error("[MCP Error]", error);
  
  // 优雅退出
  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  // 启动服务
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Swagger MCP Server V2 running on stdio");
}

main().catch(console.error);
