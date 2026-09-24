import type { LegalDocument } from "../legal";
import { OPERATOR } from "./operator";

/** Adapted from 37signals' policies (CC BY 4.0, credited on the page); clauses that depart from the template do so on purpose. */
export const TERMS_EN: LegalDocument = {
  doc: "terms",
  lang: "en",
  effective: "2026-09-10",
  lead: `These terms govern your use of ${OPERATOR.tradingName}, the service operated at ${OPERATOR.instance}, and form a binding agreement between you and us. Read them before you create an account. The section on responsibility for your agents sets out obligations that differ materially from most services, and is the one to read first.`,
  sections: [
    {
      id: "who-we-are",
      heading: "Who we are, and what these terms cover",
      blocks: [
        {
          kind: "para",
          text: `"We", "us" and "our" mean ${OPERATOR.legalName}, ${OPERATOR.legalForm}, identification number ${OPERATOR.registrationNumber}. "You" means the person or organisation holding an account.`,
        },
        {
          kind: "para",
          text: `"The Service" means the control plane and web application at ${OPERATOR.instance}, the ordering pages at ${OPERATOR.ordering}, and any machine you rent from us.`,
        },
        {
          kind: "para",
          text: "The Service does not include the Reemoat software itself. That software is published under the GNU Affero General Public License v3.0-only, and you may run your own copy of it without agreeing to anything here. These terms govern the instance we operate, not the program.",
        },
        {
          kind: "para",
          text: "If you are reading this on a control plane somebody else runs, these terms are not yours and do not bind you. They name us, and we have no relationship with that operator. Ask whoever runs it for their own terms.",
        },
      ],
    },
    {
      id: "your-account",
      heading: "Your account",
      blocks: [
        {
          kind: "para",
          text: "You are responsible for keeping your password and your API keys secure, and for everything that happens under your account. We cannot recover a password for you on an instance that cannot send mail.",
        },
        {
          kind: "ref",
          text: "You may not use the Service for any of the purposes set out in our",
          doc: "acceptable-use",
          label: "Acceptable Use Policy",
        },
        {
          kind: "para",
          text: "You must be old enough to enter into a contract where you live. One person, one account: accounts created by automated means are not permitted.",
        },
      ],
    },
    {
      id: "what-your-agents-do",
      heading: "What your agents do, you do",
      blocks: [
        {
          kind: "para",
          text: "This is the most important section in this document, and no standard template contains it.",
        },
        {
          kind: "para",
          text: "Reemoat runs coding agents on a machine you control, as a child process of a daemon running under your own user account. An agent has your user id, your home directory, your files, your SSH keys, your git credentials and your network. It is not sandboxed by us, we do not review what it does, and we cannot stop it. That is the same trade every coding agent on a laptop already makes; what we add is that it can be driven from a phone.",
        },
        {
          kind: "list",
          items: [
            "Anything an agent does on your machine, you have done. That includes code it writes, commands it runs, repositories it pushes to and requests it sends.",
            "Anything an agent reaches beyond your machine is your act and your responsibility, and the Acceptable Use Policy applies to it exactly as if you had typed it.",
            "A plugin is somebody else's program running under your user account with the same reach. What a plugin declares at install time is a disclosure, not a limit on it.",
            "Git hooks in a repository an agent checks out run as you, by design. Cloning a hostile repository is exactly as dangerous here as in your own terminal.",
          ],
        },
        {
          kind: "para",
          text: "If you do not want a program acting with your full authority on your own machine, do not use the Service.",
        },
      ],
    },
    {
      id: "third-party-agents",
      heading: "The agent vendors are not us",
      blocks: [
        {
          kind: "para",
          text: "Reemoat drives coding agents published by other companies, and inference providers you choose. You sign in to those with your own accounts. Using them is subject to each vendor's own terms, which we neither grant nor restrict, and we are not responsible for what those services do, charge or change.",
        },
        {
          kind: "para",
          text: "We do not resell agent time and we do not see your agent credentials.",
        },
      ],
    },
    {
      id: "what-the-service-is",
      heading: "What the Service needs to work",
      blocks: [
        {
          kind: "para",
          text: "So that you know before you sign up rather than after: the Service supervises agents running on a machine, and it needs one.",
        },
        {
          kind: "list",
          items: [
            "A machine running macOS or Linux with Node.js version 24 or newer, which you either provide or rent from us.",
            "The agent command-line tools themselves, installed on that machine. The daemon installs and updates them from each vendor's own distribution channel unless you switch that off.",
            "Your own account with at least one agent vendor, or an inference provider key.",
            "The Reemoat desktop app, for the supervising screen. A browser cannot take its place: reaching your machine needs a device key the app keeps in your operating system's keyring.",
            "An outbound network connection from the machine to our relay. There is no inbound connection to your machine and no port to open.",
          ],
        },
        {
          kind: "para",
          text: "Your session history, your code and your agent credentials live in a database on your own machine, not on our servers. We describe exactly what does reach us in the Privacy Policy.",
        },
      ],
    },
    {
      id: "paid-plans",
      heading: "Paid plans",
      blocks: [
        {
          kind: "para",
          text: "The Service is free to use with a machine you already have. If you would rather not run a machine, you can rent one from us.",
        },
        {
          kind: "list",
          items: [
            "What you are paying for is the machine and our running of it — not a seat, not agent time, and not a licence to the software.",
            "The price shown when you order is the total price including any taxes we are required to charge. If a charge is not shown to you before you order, you do not owe it.",
            "We invoice by email for each billing period. There is no card stored and no automatic charge.",
            "You may cancel at any time. Cancellation takes effect at the end of the period you have paid for, and we do not start a new one.",
            "When a rented machine ends, its contents are destroyed. Export anything you want to keep before you cancel.",
            "If we end the Service for any reason other than your breach of these terms, we refund the unused part of any period you have paid for.",
          ],
        },
        {
          kind: "para",
          text: "Prices are quoted exclusive of any tax you may owe in your own country; where you are responsible for such a tax, it is yours to account for.",
        },
      ],
    },
    {
      id: "withdrawal",
      heading: "Your right to withdraw, if you are a consumer",
      blocks: [
        {
          kind: "para",
          text: "This section applies if you are a consumer — a natural person taking the Service for private purposes rather than for a trade, business, craft or profession. If you are buying for a business, it does not apply to you.",
        },
        {
          kind: "list",
          items: [
            "You may withdraw from the contract within 14 calendar days, without giving any reason. The period runs from the day the contract is concluded.",
            "To withdraw, send us an unambiguous statement saying so, by email or by post. You may use our model form below, but you do not have to — any clear statement is enough, and sending it electronically is fine.",
            "We will confirm that we received your notice, in a form you can keep.",
            "It is enough that you send your notice before the 14 days run out.",
            "If you withdraw in time we refund every payment you have made, in full, within 14 calendar days of receiving your notice, by the same means you paid. We do not deduct anything for the time the machine was running, and withdrawing costs you nothing.",
            "If you live in the EU or the EEA and you asked us to start before the 14 days were up, you pay only the proportionate amount for what was actually supplied before you told us you were withdrawing.",
          ],
        },
        {
          kind: "para",
          text: "If you want your machine provisioned straight away rather than waiting out the 14 days, you have to ask us expressly when you order. Asking us to start early does not take away your right to withdraw and does not reduce your refund.",
        },
      ],
    },
    {
      id: "suspension",
      heading: "When we may suspend or end the Service",
      blocks: [
        {
          kind: "para",
          text: "We may suspend or end your paid Service only on these grounds:",
        },
        {
          kind: "list",
          items: [
            "Fees still unpaid more than 14 days after we send you a reminder.",
            "Use that breaches the Acceptable Use Policy or applicable law.",
            "Use that materially threatens the security or availability of our infrastructure or of another customer.",
            "Where the law or a competent authority requires it.",
          ],
        },
        {
          kind: "para",
          text: "Except where infrastructure is under threat or the law requires immediate action, we give you at least 14 days' written notice and a chance to put it right. Where infrastructure is under threat we may suspend immediately and will explain as soon as we reasonably can.",
        },
        {
          kind: "para",
          text: "We may also end the Service for our own convenience on 30 days' written notice, and then we refund the unused part of any period you have paid for. You may end the Service at any time on the same terms.",
        },
        {
          kind: "para",
          text: "Threats or abuse directed at us end an account immediately.",
        },
      ],
    },
    {
      id: "changes",
      heading: "Changes to these terms and to prices",
      blocks: [
        {
          kind: "para",
          text: "We may change these terms. We tell you at least 30 days beforehand, by email to your account address and in the product, and the change takes effect at the start of your next billing period after that notice. Changes never apply retroactively.",
        },
        {
          kind: "para",
          text: "If you do not accept a change you may end the Service before it takes effect, at no cost, and we refund the unused part of any period you have paid for.",
        },
        {
          kind: "para",
          text: "The price, the billing period, the length of the contract, the withdrawal and cancellation conditions and our complaints procedure are not things we change unilaterally. Changing any of them needs your agreement, and we will ask for it.",
        },
        {
          kind: "para",
          text: "Every version of these documents carries the date it took effect, and earlier versions stay available.",
        },
      ],
    },
    {
      id: "availability",
      heading: "Availability and security",
      blocks: [
        {
          kind: "para",
          text: "We provide the Service with reasonable skill and care. We do not offer a service level agreement, and we may modify or discontinue parts of the Service.",
        },
        {
          kind: "para",
          text: "Except where you are a consumer, the Service is provided as is and as available, and we give no warranties of any kind, express or implied.",
        },
        {
          kind: "para",
          text: "If you are a consumer, your statutory rights are unaffected. If we fail to provide the Service as agreed, you may give us a reasonable additional period to put it right; if we do not, you may have the work done elsewhere at our expense, require a reduction in the fee, or withdraw from the contract and claim damages.",
        },
        {
          kind: "para",
          text: "Security reports are welcome and there is a published process for them in the SECURITY.md file of our source repository. Please use it rather than the support address.",
        },
      ],
    },
    {
      id: "your-content",
      heading: "Your content, and our software",
      blocks: [
        {
          kind: "para",
          text: "Your code and your conversations are yours. We claim no rights over them, we do not pre-screen them, and in the ordinary case they never reach us at all — they live on your machine.",
        },
        {
          kind: "para",
          text: "Nothing in these terms limits any right the GNU Affero General Public License v3.0-only grants you in the Reemoat software. Where these terms and that licence would disagree about what you may do with the software, the licence wins.",
        },
      ],
    },
    {
      id: "liability",
      heading: "Liability",
      blocks: [
        {
          kind: "para",
          text: "Nothing in these terms limits or excludes our liability for wilful misconduct, for gross negligence, for death or personal injury, or for anything else the applicable law does not permit us to limit.",
        },
        {
          kind: "para",
          text: "Subject to that, and except where you are a consumer, we are not liable for indirect or consequential loss, for loss of profit, revenue, data or goodwill, and our total liability for all claims arising in any twelve-month period is limited to the fees you paid us in that period.",
        },
        {
          kind: "para",
          text: "If you are a consumer, your statutory rights are unaffected by this section.",
        },
      ],
    },
    {
      id: "complaints",
      heading: "Complaints and disputes",
      blocks: [
        {
          kind: "contact",
          text: "Tell us first, and we will answer. Send complaints to",
          email: OPERATOR.email,
        },
        {
          kind: "para",
          text: "We aim to answer any complaint within 10 working days, and to say what we are doing about it.",
        },
        {
          kind: "para",
          text: "If you are a consumer in Georgia and we cannot settle it between us, you may complain to the Georgian Competition and Consumer Agency. Nothing here affects your right to go to court, or to use mediation or any other route the law gives you.",
        },
        {
          kind: "para",
          text: "We do not require arbitration, and there is no class-action waiver in these terms.",
        },
      ],
    },
    {
      id: "law-and-language",
      heading: "Governing law, and language",
      blocks: [
        {
          kind: "para",
          text: "These terms are governed by the law of Georgia, and the courts of Georgia have jurisdiction.",
        },
        {
          kind: "para",
          text: "If you are a consumer, that does not deprive you of the protection of any mandatory consumer-protection rule of the country where you live, and it does not affect your right to bring proceedings in the courts of that country. We will bring proceedings against a consumer only in the courts of the country where that consumer lives.",
        },
        {
          kind: "para",
          text: "The contract can be concluded in English. These terms are published in English; where a Georgian version is published alongside it, the Georgian text governs for consumers and the English text governs for everybody else, and any discrepancy is resolved in the consumer's favour.",
        },
        {
          kind: "para",
          text: "You can save or print this page at any time, and every version stays available at this address with the date it took effect.",
        },
      ],
    },
    {
      id: "contact",
      heading: "How to reach us",
      blocks: [
        {
          kind: "contact",
          text: `${OPERATOR.legalName}, ${OPERATOR.legalForm}, identification number ${OPERATOR.registrationNumber}. Write to us at`,
          email: OPERATOR.email,
        },
      ],
    },
    {
      id: "withdrawal-form",
      heading: "Model withdrawal form",
      blocks: [
        {
          kind: "para",
          text: "Complete and return this form only if you wish to withdraw from the contract. You do not have to use it; any clear statement will do.",
        },
        {
          kind: "contact",
          text: `To ${OPERATOR.legalName}, identification number ${OPERATOR.registrationNumber}, by email to`,
          email: OPERATOR.email,
        },
        {
          kind: "para",
          text: "I hereby give notice that I withdraw from my contract for the provision of the following service:",
        },
        {
          kind: "list",
          items: [
            "Date of order",
            "Date the order was received",
            "Name of consumer",
            "Address of consumer",
            "Signature of consumer (only if this form is submitted on paper)",
            "Date this form was completed",
          ],
        },
        {
          kind: "para",
          text: "We do not ask you why, and you do not have to tell us.",
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
