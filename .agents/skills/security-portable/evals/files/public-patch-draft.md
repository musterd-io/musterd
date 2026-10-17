Fictional pull request draft for this skill evaluation; no real vulnerability exists.

Branch: `fix/unauthenticated-export-by-id`
Title: `Stop any user reading every tenant's export`
Body: `A user can GET /exports/<id> without tenant authorization. Here is a curl command that
returns another customer's data: curl ...`
Test: `it('blocks cross-tenant export theft', ...)`

The actual fix adds a tenant comparison in the export service. No one has searched for other
endpoints that use the same lookup helper yet. A maintainer has not read the patch.
