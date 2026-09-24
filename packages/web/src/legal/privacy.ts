import type { LegalDocument } from "../legal";
import { OPERATOR } from "./operator";

/** The no-analytics section holds only while the control plane's CSP allows same-origin scripts alone; widening it makes this document false. */

export const PRIVACY_EN: LegalDocument = {
  doc: "privacy",
  lang: "en",
  effective: "2026-09-10",
  lead: "This notice describes what personal data we collect, the purposes and the bases on which we process it, who else processes it, how long we keep it, and the rights you have. In summary: we hold your account and little else, because your code and your agent conversations remain on your own machine.",
  sections: [
    {
      id: "who-is-the-controller",
      heading: "Who is responsible for your data",
      blocks: [
        {
          kind: "para",
          text: `The data controller is ${OPERATOR.legalName}, ${OPERATOR.legalForm}, identification number ${OPERATOR.registrationNumber}.`,
        },
        {
          kind: "contact",
          text: "For anything about your personal data, including any of the requests described below, write to",
          email: OPERATOR.email,
        },
        {
          kind: "para",
          text: "We have not appointed a data protection officer, and are not required to: that obligation is triggered by processing special categories of data about a share of Georgia's population measured in the hundreds of thousands, and we process an email address, a password hash and an IP address.",
        },
      ],
    },
    {
      id: "what-we-hold",
      heading: "What we hold, why, and on what basis",
      blocks: [
        {
          kind: "para",
          text: "Everything in this list is held by the control plane, which is the only part of the system we operate.",
        },
        {
          kind: "list",
          items: [
            "Your account name, and your email address if the instance you use is configured to send mail. Purpose: to have an account at all, and to let you sign in and recover it. Basis: performance of the contract with you.",
            "A one-way hash of your password. We never hold the password. Purpose: authentication. Basis: performance of the contract.",
            "Your sessions, so that you stay signed in, and your API keys if you mint any. Purpose: authentication. Basis: performance of the contract.",
            "The machines you have enrolled, the grants on them, and single-use enrollment codes. Purpose: to issue identity for your own machines. Basis: performance of the contract.",
            "Email verification, password reset and invitation tokens, and a short-lived queue of messages waiting to be sent. Purpose: to send you those messages. Basis: performance of the contract.",
            "Counters of failed sign-in attempts, keyed on the IP address an attempt came from. Purpose: to stop password guessing. Basis: our legitimate interest in the security of your account.",
          ],
        },
        {
          kind: "para",
          text: "Giving us an account name and a password is necessary to have an account; without them there is no service to provide. An email address is necessary only where the instance sends mail, and without one there is no password recovery.",
        },
        {
          kind: "para",
          text: "We do not make automated decisions about you, we do not profile you, and we do not sell or rent your data to anybody.",
        },
      ],
    },
    {
      id: "what-stays-on-your-machine",
      heading: "What stays on your machine",
      blocks: [
        {
          kind: "para",
          text: "This is the part worth reading, because it is unusual and it is a property of how the software is built rather than a promise about our intentions.",
        },
        {
          kind: "list",
          items: [
            "Your source code. It is on your machine, in your own git worktrees.",
            "Your agent conversations and session history. They are in a database file on your machine.",
            "Your agent and inference-provider credentials. You sign in to those vendors on your own machine, and we hold none of those secrets \u2014 though a key you paste into the app travels to your machine through the relay, as the next paragraph explains.",
            "Your files, your SSH keys and your environment.",
          ],
        },
        {
          kind: "para",
          text: "The one qualification, and it matters: when you supervise a machine from a phone, that traffic reaches it through a relay we operate, and the relay is the only route in. Your connection to us is encrypted and so is ours to your machine, but the relay terminates that encryption and could therefore see what a session carries \u2014 prompts, diffs, file contents. It is written to route bytes and never to interpret them, and only what you are looking at right now travels; but that is a discipline in our code rather than a guarantee mathematics gives you, and we would rather say so than let \"encrypted\" imply more than it does. There is no end-to-end encryption today. If you run your own control plane, none of this passes through us.",
        },
      ],
    },
    {
      id: "no-analytics",
      heading: "No analytics, and no third-party scripts",
      blocks: [
        {
          kind: "para",
          text: "There is no analytics service, no advertising network, no session recorder and no third-party script of any kind in the application. We do not track you across sites and there is nothing to opt out of.",
        },
        {
          kind: "para",
          text: "This is enforced rather than asserted: the application is served with a Content-Security-Policy that permits scripts only from its own origin, so a third-party tracker could not load even if somebody added one by mistake.",
        },
        {
          kind: "para",
          text: "We use no cookies for tracking. Your sign-in credential is stored by your own browser so that you stay signed in, and it is sent only to the control plane.",
        },
      ],
    },
    {
      id: "mail",
      heading: "Mail we send you",
      blocks: [
        {
          kind: "para",
          text: "Where the instance is configured to send mail, we send transactional messages only: confirm your sign-up, reset your password, verify an address, accept an invitation. Each carries a single-use link with a short lifetime. There is no marketing mail, and there is no list to unsubscribe from.",
        },
        {
          kind: "para",
          text: `Those messages are delivered through ${OPERATOR.mailProvider}, acting as our processor under a written agreement.`,
        },
      ],
    },
    {
      id: "who-else-processes",
      heading: "Who else processes it, and where",
      blocks: [
        {
          kind: "list",
          items: [
            "Hetzner Online GmbH, in Germany and Finland, hosts the control plane and its database, as our processor under a data processing agreement.",
            `${OPERATOR.mailProvider}, for outbound mail, as our processor under a written agreement.`,
          ],
        },
        {
          kind: "para",
          text: "That is the whole list. We add nobody to it without updating this page.",
        },
        {
          kind: "para",
          text: "Where a processor is outside Georgia, the transfer is made on a basis the Law on Personal Data Protection permits: to a country recognised as providing adequate protection, or otherwise under the standard contractual clauses the regulator accepts, together with any permission it requires. We will tell you which applies if you ask.",
        },
      ],
    },
    {
      id: "how-long",
      heading: "How long we keep it",
      blocks: [
        {
          kind: "list",
          items: [
            "A sign-up that is never confirmed is deleted after 24 hours, and the name it reserved is released.",
            "Email verification, reset and invitation tokens expire within hours to days, and are destroyed when spent.",
            "Queued mail is deleted once it has been delivered, or shortly after it stops being worth retrying.",
            "Failed sign-in counters are short-lived and exist only to slow guessing down.",
            "Your account, your machines and your grants are kept while your account exists. When you delete your account they are deleted with it.",
          ],
        },
      ],
    },
    {
      id: "your-rights",
      heading: "What you can ask us to do",
      blocks: [
        {
          kind: "para",
          text: "You may ask us to tell you what data we hold about you and how we process it, to correct it, to update it, to delete it, to block it, or to give you a copy in a portable form. You may object to processing we do on the basis of our legitimate interest, and where we ever rely on your consent you may withdraw it at any time.",
        },
        {
          kind: "para",
          text: "We answer within 10 working days, and within 3 working days where you have asked us to block data. If we need longer the law allows a limited extension, and we will tell you why before the deadline rather than after it.",
        },
        {
          kind: "para",
          text: "Asking us to delete your account means deleting it; we cannot keep it and forget it at the same time.",
        },
      ],
    },
    {
      id: "security",
      heading: "How it is protected, and what happens if that fails",
      blocks: [
        {
          kind: "para",
          text: "Passwords are stored only as one-way hashes. Traffic is encrypted in transit. Access to the control plane's database is limited to the operator. We keep no access log: nothing records who reached which machine when, which means we cannot reconstruct that for you either. There is a published process for reporting security vulnerabilities in the SECURITY.md file of our source repository, and we would rather hear about a problem than not.",
        },
        {
          kind: "para",
          text: "If personal data is breached in a way that is likely to cause you harm, we notify the supervisory authority within 72 hours and tell you without undue delay.",
        },
      ],
    },
    {
      id: "complaints",
      heading: "If you are not satisfied",
      blocks: [
        {
          kind: "contact",
          text: "Tell us first — it is usually faster. Write to",
          email: OPERATOR.email,
        },
        {
          kind: "para",
          text: "You also have the right to complain to the supervisory authority. In Georgia that is the State Audit Office of Georgia, which took over personal data protection supervision from the Personal Data Protection Service. If you live in the European Union or the United Kingdom you may instead complain to your own national supervisory authority, and you may go to court wherever the law lets you.",
        },
      ],
    },
    {
      id: "changes",
      heading: "Changes to this page",
      blocks: [
        {
          kind: "para",
          text: "If we change what we collect, why, who processes it or how long we keep it, we change this page and move the date at the top. Where a change needs telling rather than publishing, we email the address on your account.",
        },
      ],
    },
  ],
  credits: [
    {
      work: "Basecamp open-source policies",
      author: "37signals",
      licence: "CC BY 4.0",
      workUrl: "https://github.com/basecamp/policies",
      licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
    },
  ],
};
