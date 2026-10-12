# frozen_string_literal: true

# Homebrew formula for musterd (ADR 156) — npm package via registry tarball.
# Source of truth in the musterd monorepo; copy to SandRiseStudio/homebrew-musterd as Formula/musterd.rb
#
#   brew tap SandRiseStudio/musterd
#   brew trust sandrisestudio/musterd   # first time (Homebrew tap trust)
#   brew install musterd
#
# After an npm publish:
#   pnpm bump-brew-formula --version X.Y.Z

class Musterd < Formula
  desc "Your agents, on a team with you"
  homepage "https://github.com/musterd-io/musterd"
  url "https://registry.npmjs.org/@musterd/cli/-/cli-0.5.0.tgz"
  sha256 "0e36857e30499d73e2a26b98844997f8e0efc6a58ed59f9cf2a39a1bf7a69799"
  license "MIT"

  # better-sqlite3 (via @musterd/server) needs a supported Node ABI — pin Node 22 (engines >=22).
  depends_on "node@22"

  def install
    node22 = Formula["node@22"].opt_bin
    ENV.prepend_path "PATH", node22

    # Avoid Homebrew's std_npm_args (--min-release-age blocks fresh publishes; --build-from-source
    # breaks better-sqlite3 when prebuilds exist). Use node@22 + allow prebuilds.
    system "npm", "install", "-ddd", "--global",
           "--cache=#{HOMEBREW_CACHE}/npm_cache",
           "--prefix=#{libexec}",
           "--min-release-age=0",
           cached_download

    # Shebang `env node` can pick Homebrew's latest node (26+); bind the bin to node@22.
    (bin/"musterd").write <<~EOS
      #!/bin/bash
      exec "#{node22}/node" "#{libexec}/lib/node_modules/@musterd/cli/dist/bin.js" "$@"
    EOS
  end

  def caveats
    <<~EOS
      musterd runs on Node 22 (Homebrew node@22).

      Next:
        musterd init

      Upgrade:
        brew upgrade musterd

      Packaged installs cannot `musterd service refresh` (that rebuilds a git checkout).
      Use `brew upgrade musterd` instead.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/musterd --version")
  end
end
