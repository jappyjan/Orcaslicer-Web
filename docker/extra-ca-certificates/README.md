# Extra CA certificates

Drop PEM-encoded `*.crt` files here if `docker build` has to fetch the OrcaSlicer
AppImage and the Node tarball through a TLS-inspecting proxy. The Dockerfile copies
this directory into `/usr/local/share/ca-certificates/extra/` and runs
`update-ca-certificates`.

Empty by default — on a normal machine this is a no-op. `*.crt` / `*.pem` here are
gitignored so a site-local certificate never lands in the repository.
