<!-- Eval input. FICTIONAL readings written for this eval; times are local, read at 14:32 on 2026-10-13. -->

$ curl -s localhost:4849/health
{"ok":true,"build":"0d86d050","booted_at":"2026-10-13T14:21:07-07:00","schema":94,"db":"/Users/me/.musterd/musterd.db"}

$ launchctl print gui/501/studio.sandrise.musterd | grep -E "state|last exit|pid"
	state = running
	pid = 36449
	last exit code = 0

$ tail -n 12 ~/.musterd/daemon.err.log
2026-10-12T09:14:02 Error: SQLITE_BUSY: database is locked
2026-10-12T09:14:02     at Statement.run (better-sqlite3)
2026-10-12T09:14:03 musterd daemon exiting (code 1)
2026-10-12T09:14:13 Error: SQLITE_BUSY: database is locked
2026-10-12T09:14:13 musterd daemon exiting (code 1)
2026-10-12T09:14:23 Error: SQLITE_BUSY: database is locked
2026-10-12T09:14:23 musterd daemon exiting (code 1)
2026-10-12T09:14:33 Error: SQLITE_BUSY: database is locked
2026-10-12T09:14:33 musterd daemon exiting (code 1)
2026-10-12T09:14:44 Error: SQLITE_BUSY: database is locked
2026-10-12T09:14:44 musterd daemon exiting (code 1)
2026-10-12T09:15:02 musterd daemon listening on 127.0.0.1:4849
