// The inputs of the tools this plugin registers in session.start, in the shape
// the engine lays for connected MCP tools (.claude-plugin/types/claude-code-mcp),
// so `{ tool: 'mcp__sonarqube__sonarqube_issues' }` matchers type `e` before a save
// regenerates that file. Keep them in step with the inputSchema in hooks/register.tsx.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    mcp__sonarqube__sonarqube_quality_gate: {
      projectKey?: string
      branch?: string
      pullRequest?: string
    }
    mcp__sonarqube__sonarqube_measures: {
      metricKeys: string[]
      projectKey?: string
      branch?: string
      pullRequest?: string
    }
    mcp__sonarqube__sonarqube_issues: {
      projectKey?: string
      branch?: string
      pullRequest?: string
      statuses?: ('OPEN' | 'CONFIRMED' | 'REOPENED' | 'RESOLVED' | 'CLOSED')[]
      severities?: ('BLOCKER' | 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO')[]
      type?: 'BUG' | 'VULNERABILITY' | 'CODE_SMELL'
      page?: number
      pageSize?: number
    }
    mcp__sonarqube__sonarqube_issue: {
      issueKey: string
      projectKey?: string
      branch?: string
      pullRequest?: string
    }
    mcp__sonarqube__sonarqube_rule: {
      ruleKey: string
    }
    mcp__sonarqube__sonarqube_hotspots: {
      projectKey?: string
      branch?: string
      pullRequest?: string
      status?: 'TO_REVIEW' | 'REVIEWED'
      page?: number
      pageSize?: number
    }
    mcp__sonarqube__sonarqube_branches: {
      projectKey?: string
      branch?: string
    }
  }
}
