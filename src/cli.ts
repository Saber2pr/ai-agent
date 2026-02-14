#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { CONFIG_FILE as configFile } from './config/config';
import { createInterface } from 'readline';
import { createAgent } from './agent/createAgent';

interface Config {
  apiKey: string;
  apiUrl: string;
}

// 读取配置文件
function loadConfig(): Config | null {
  if (!existsSync(configFile)) {
    return null;
  }

  try {
    const content = readFileSync(configFile, 'utf-8');
    const config = JSON.parse(content) as Config;

    // 验证配置完整性
    if (!config.apiKey || !config.apiUrl) {
      return null;
    }

    return config;
  } catch (error) {
    console.error(`读取配置文件失败: ${configFile}`, error);
    return null;
  }
}

// 保存配置文件
function saveConfig(config: Config): void {
  try {
    writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`配置已保存到: ${configFile}`);
  } catch (error) {
    console.error(`保存配置文件失败: ${configFile}`, error);
    process.exit(1);
  }
}

// CLI 交互式输入配置
async function promptConfig(): Promise<Config> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (query: string): Promise<string> => {
    return new Promise(resolve => {
      rl.question(query, resolve);
    });
  };

  try {
    console.log('\n欢迎使用 AI Agent CLI！');
    console.log('首次使用需要配置 API 信息。\n');

    const apiUrlInput = await question(`请输入 API URL: `);
    if (!apiUrlInput.trim()) {
      console.error('API URL 不能为空！');
      rl.close();
      process.exit(1);
    }

    const apiKey = await question('请输入 API Key: ');
    if (!apiKey.trim()) {
      console.error('API Key 不能为空！');
      rl.close();
      process.exit(1);
    }

    const apiUrl = apiUrlInput.trim();

    rl.close();

    const config: Config = {
      apiKey: apiKey.trim(),
      apiUrl: apiUrl.trim(),
    };

    return config;
  } catch (error) {
    rl.close();
    console.error('输入配置时出错:', error);
    process.exit(1);
  }
}


// 主函数
async function main() {
  let config = loadConfig();

  // 如果配置不存在或不完整，提示用户输入
  if (!config) {
    console.log(`未找到配置文件或配置不完整。${configFile}`);
    config = await promptConfig();
    saveConfig(config);
  }

  // 创建并启动 agent（默认开启流式输出）
  const agent = createAgent({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    stream: true,
    targetDir: process.cwd()
  });

  const model = await agent.ensureInitialized()
  if (process.env.AI_AGENT_CLI_NO_MCP) {
    model.setMcpEnabled(false);
  }

  console.log('欢迎使用 AI Agent CLI！请输入问题，按 Ctrl+C 退出。\n当前目录：', process.cwd());
  await agent.start();
}

main().catch(error => {
  console.error('启动失败:', error);
  process.exit(1);
});
