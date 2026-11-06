import { SIGN_IN_PATH } from './hostedSession';

/**
 * A hosted team's signed-out `/live` (ADR 722, unified sign-in §5): one way in, nothing to paste.
 * The link goes to the team's own start route, which sends the browser to the console and back.
 * Words are the sign-in copy spec's §4 (`docs/design/sign-in-copy-spec.md`), verbatim; the
 * heading is held for sloane's review.
 */
export function HostedSignIn({ notice }: { notice: string | null }) {
  return (
    <div className="lc-form">
      <div className="lc-form__card">
        <h1 className="lc-form__title">Sign in</h1>
        {notice && (
          <p className="lc-form__error" role="status">
            {notice}
          </p>
        )}
        <a className="lc-form__connect lc-form__connect--link" href={SIGN_IN_PATH}>
          Sign in with musterd
        </a>
      </div>
    </div>
  );
}
