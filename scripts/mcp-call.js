#!/usr/bin/env node
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// 默认配置
const DEFAULT_MCP_SERVER = '/Users/kl/Documents/ai/kanban/mcp-server/dist/index.js';
const DEFAULT_API_URL = 'http://localhost:8080';

// 读取 .mcp.json 配置
function loadMcpConfig() {
  const configPaths = [
    path.join(process.cwd(), '.mcp.json'),
    path.join(process.env.HOME, '.mcp.json'),
    '.mcp.json',
  ];
  
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        for (const [name, server] of Object.entries(config.mcpServers || {})) {
          return {
            command: server.command,
            args: server.args,
            env: server.env || {}
          };
        }
      } catch (e) {}
    }
  }
  return null;
}

// 主函数
function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node mcp-call.js <tool_name> <tool_args_json>');
    console.error('Example: node mcp-call.js list_tasks \'{"boardId":"xxx","status":"todo"}\'');
    process.exit(1);
  }

  const toolName = args[0];
  const toolArgs = JSON.parse(args[1] || '{}');

  // 加载 MCP 配置
  const mcpConfig = loadMcpConfig();
  
  // 环境变量优先级: 命令行参数 > .mcp.json > 环境变量
  const mcpServer = process.env.MCP_SERVER_PATH || 
    (mcpConfig && mcpConfig.args && mcpConfig.args[0]) || 
    DEFAULT_MCP_SERVER;
  
  const apiUrl = process.env.KANBAN_API_URL || 
    (mcpConfig && mcpConfig.env && mcpConfig.env.KANBAN_API_URL) || 
    DEFAULT_API_URL;
  
  const mcpToken = process.env.KANBAN_MCP_TOKEN || 
    (mcpConfig && mcpConfig.env && mcpConfig.env.KANBAN_MCP_TOKEN) || 
    undefined;

  console.error(`MCP Server: ${mcpServer}`);
  console.error(`API URL: ${apiUrl}`);

  const initializeMsg = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '1.0.0' }
    }
  };

  const toolsCallMsg = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: toolArgs
    }
  };

  // 构建环境变量
  const env = { ...process.env };
  env.KANBAN_API_URL = apiUrl;
  if (mcpToken) env.KANBAN_MCP_TOKEN = mcpToken;

  const server = spawn('node', [mcpServer], { env });

  let responseData = '';

  const rl = readline.createInterface({ input: server.stdout });

  server.stderr.on('data', (data) => {
    // 忽略 stderr
  });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      responseData = msg;
      if (msg.id === 2) {
        server.kill();
      }
    } catch (e) {
      // 非 JSON 行，忽略
    }
  });

  server.on('close', () => {
    if (responseData && responseData.result) {
      const content = responseData.result.content;
      if (content && content[0] && content[0].text) {
        try {
          console.log(JSON.stringify(JSON.parse(content[0].text), null, 2));
        } catch {
          console.log(content[0].text);
        }
      } else {
        console.log(JSON.stringify(responseData.result, null, 2));
      }
    } else if (responseData && responseData.error) {
      console.error('Error:', JSON.stringify(responseData.error, null, 2));
      process.exit(1);
    }
  });

  // 发送初始化消息
  server.stdin.write(JSON.stringify(initializeMsg) + '\n');

  // 等待后发送工具调用
  setTimeout(() => {
    server.stdin.write(JSON.stringify(toolsCallMsg) + '\n');
  }, 100);
}

main();
