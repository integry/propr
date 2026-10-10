`agent-tank-0.9.11.patch` carries the Agent Tank provider fixes developed in
`integry/agent-tank` until they are included in a published package version.
It adds native Antigravity configuration isolation, current Claude quota-schema
support, startup/partial-render handling, and provider refresh throttling.

The patch applies to the pinned npm package during the agent image build. It is
included in both bundle content-hash lists, so changing it creates a new image
tag. Remove the patch and its build/hash references when upgrading to a release
that contains these fixes.
