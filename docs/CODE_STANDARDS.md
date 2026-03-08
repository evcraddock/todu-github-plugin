# Code Standards

## Formatting

Use Prettier. Run before committing:

```bash
npm run format
```

## Linting

Use ESLint:

```bash
npm run lint
```

## TypeScript

### Strict Mode

TypeScript strict mode is enabled. No implicit `any`, strict null checks.

```typescript
// ❌ Bad
const data = response as any;

// ✅ Good
const data: ApiResponse = response;
```

### Types

- Define types for all function parameters and return values
- Use interfaces for object shapes
- Export types that are part of public API

```typescript
interface GitHubIssue {
  id: number;
  title: string;
  state: "open" | "closed";
}

function mapIssue(issue: GitHubIssue): string {
  return issue.title;
}
```

### Null Handling

- Use optional chaining (`?.`) and nullish coalescing (`??`)
- Handle null cases explicitly

```typescript
const title = issue.title ?? "Untitled";
const assignee = issue.assignee?.login;
```

## Imports

- Use path aliases (`@/...`) where they improve readability
- Group: external, internal, relative

```typescript
// External
import { describe, expect, it } from "vitest";

// Internal
import { formatIssueExternalId } from "@/index";

// Relative
import { normalizeIssue } from "./normalize-issue";
```

## Exports

- Use named exports (not default)
- Re-export from `index.ts` for public API

## Functions

- Keep functions small
- Give each function a single responsibility
- Use object params for 3+ parameters when it improves readability

## Error Handling

- Throw errors for exceptional cases
- Include context in error messages

```typescript
if (issueNumber <= 0) {
  throw new Error(`Invalid GitHub issue number: ${issueNumber}`);
}
```

## Testing

- Use Vitest
- Test public functions
- Use `describe`/`it` blocks

```typescript
describe("formatIssueExternalId", () => {
  it("formats owner, repo, and issue number", () => {
    expect(formatIssueExternalId({ owner: "acme", repo: "roadmap", issueNumber: 42 })).toBe(
      "acme/roadmap#42"
    );
  });
});
```
