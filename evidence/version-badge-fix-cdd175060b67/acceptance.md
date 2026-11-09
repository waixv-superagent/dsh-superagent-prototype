# one-click update acceptance

- result: **ok**
- window: 2026-11-09 14:33:59 - 14:38:40 CST

## before
```json
{
    "enabled":  true,
    "installed":  "cb2d8c344d236150aa610f91f3e71f2114f2acac",
    "remote":  "e138019b5c5849006a7c1f8481632e77c1b0ddbb",
    "available":  true,
    "behind":  24,
    "run":  "down"
}
```

## update
```json
{
    "state":  "done",
    "sha":  "e138019b5c5849006a7c1f8481632e77c1b0ddbb",
    "from":  "cb2d8c344d236150aa610f91f3e71f2114f2acac",
    "error":  null,
    "steps":  [
                  {
                      "name":  "fetch",
                      "state":  "done",
                      "detail":  "",
                      "at":  "2026-11-09T06:34:30.888Z"
                  },
                  {
                      "name":  "worktree",
                      "state":  "done",
                      "detail":  "C:\\Users\\wanghuaiyang\\.dsh\\state\\superagent\\upgrade\\build",
                      "at":  "2026-11-09T06:35:00.551Z"
                  },
                  {
                      "name":  "install",
                      "state":  "done",
                      "detail":  "",
                      "at":  "2026-11-09T06:35:08.970Z"
                  },
                  {
                      "name":  "typecheck",
                      "state":  "done",
                      "detail":  "",
                      "at":  "2026-11-09T06:35:24.787Z"
                  },
                  {
                      "name":  "test",
                      "state":  "done",
                      "detail":  "",
                      "at":  "2026-11-09T06:37:32.970Z"
                  },
                  {
                      "name":  "build",
                      "state":  "done",
                      "detail":  "",
                      "at":  "2026-11-09T06:37:39.745Z"
                  },
                  {
                      "name":  "pause",
                      "state":  "done",
                      "detail":  "",
                      "at":  "2026-11-09T06:37:39.759Z"
                  },
                  {
                      "name":  "idle",
                      "state":  "done",
                      "detail":  "forced",
                      "at":  "2026-11-09T06:37:39.759Z"
                  },
                  {
                      "name":  "stop",
                      "state":  "done",
                      "detail":  "",
                      "at":  "2026-11-09T06:37:43.456Z"
                  },
                  {
                      "name":  "backup",
                      "state":  "done",
                      "detail":  "C:\\Users\\wanghuaiyang\\.dsh\\state\\superagent\\upgrade\\backup",
                      "at":  "2026-11-09T06:37:43.543Z"
                  },
                  {
                      "name":  "replace",
                      "state":  "done",
                      "detail":  "",
                      "at":  "2026-11-09T06:37:43.609Z"
                  },
                  {
                      "name":  "start",
                      "state":  "done",
                      "detail":  "",
                      "at":  "2026-11-09T06:38:00.075Z"
                  },
                  {
                      "name":  "resume",
                      "state":  "failed",
                      "detail":  "The operation was aborted due to timeout",
                      "at":  "2026-11-09T06:38:10.077Z"
                  }
              ]
}
```

## after
```json
{
    "pid":  45288,
    "beforePid":  26720,
    "runtime":  "ready",
    "buildInfoSha":  "e138019b5c5849006a7c1f8481632e77c1b0ddbb",
    "installed":  "e138019b5c5849006a7c1f8481632e77c1b0ddbb",
    "remote":  "e138019b5c5849006a7c1f8481632e77c1b0ddbb",
    "available":  false,
    "run":  "done"
}
```
