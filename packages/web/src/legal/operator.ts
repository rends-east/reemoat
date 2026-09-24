// Its own module so the documents can import it without a circular import reading it in its temporal dead zone.

/** The party the documents bind: a fork must replace every field, and an unfilled placeholder blocks publication. */
export const OPERATOR = {
  tradingName: "Reemoat",
  legalName: "Nikita Kinelovsky",
  legalForm: "Individual Entrepreneur (ინდივიდუალური მეწარმე), registered in Georgia",
  registrationNumber: "306567943",
  address: null,
  email: "info@reemoat.com",
  // A processor outside Georgia: the transfer paragraph in privacy.ts depends on it and must not be shortened without the paperwork.
  mailProvider: "Namecheap, Inc. (Private Email), in the United States",
  instance: "app.reemoat.com",
  ordering: "get.reemoat.com",
} as const;

/** Required fields still holding a placeholder; read at run time, and any entry stops the documents and the consent box. */
export function operatorIncomplete(): readonly string[] {
  // address is null by decision rather than unfilled, so it is not listed.
  return (["legalName", "registrationNumber", "mailProvider"] as const).filter((field) =>
    OPERATOR[field].startsWith("TODO"),
  );
}

/** The server's REEMOAT_CP_LEGAL_DOCUMENTS switch cannot see this; switched on while this is false, the register route refuses every sign-up. */
export function legalPublishable(): boolean {
  return operatorIncomplete().length === 0;
}
