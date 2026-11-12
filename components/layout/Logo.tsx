/** Logo-Zeichen in Hell- und Dunkelvariante (die passende wird per CSS eingeblendet). */
export function Logo() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/img/logo-mark-on-light.svg" alt="" className="logo-light" width={307} height={123} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/img/logo-mark-on-dark.svg" alt="" className="logo-dark" width={307} height={123} />
    </>
  );
}
