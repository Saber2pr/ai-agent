#!/usr/bin/env node

import McpGraphAgent from './core/agent-graph';

const agent = new McpGraphAgent({
  stream: true,
});
agent.start();