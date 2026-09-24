import type { LegalDocument } from "../legal";
import { OPERATOR } from "./operator";

/** Adapted from github/site-policy (CC0) and 37signals (CC BY 4.0, credited on the page); the bug-bounty and dual-use carve-outs are deliberate. */
export const ACCEPTABLE_USE_EN: LegalDocument = {
  doc: "acceptable-use",
  lang: "en",
  effective: "2026-09-10",
  lead: "While you use Reemoat you must comply with this policy. It sets out the restrictions that apply to your conduct and to what you store, generate or transmit through the Service: unauthorised access to systems that are not yours, malware and attack infrastructure, spam, prohibited content, interference with the Service, and limits on how much of it you may consume. Breaking any of them is grounds for us to suspend or end your account.",
  sections: [
    {
      id: "laws",
      heading: "Compliance with the law",
      blocks: [
        {
          kind: "para",
          text: "You are responsible for using the Service in compliance with all laws and regulations that apply to you, and with this policy. An agent acting on your behalf is you, so everything below covers what your agents do as well as what you do yourself.",
        },
      ],
    },
    {
      id: "other-peoples-systems",
      heading: "Other people's systems",
      blocks: [
        {
          kind: "para",
          text: "This is the rule that matters most here, because an agent on your machine has a shell and a network connection.",
        },
        {
          kind: "para",
          text: "Do not use the Service to disrupt, or attempt to disrupt, or to gain or attempt to gain unauthorised access to, any service, device, data, account or network that you do not own or have written permission to test. That includes port and vulnerability scanning, credential stuffing and password guessing, exploiting a system you do not control, and denial-of-service traffic of any kind.",
        },
        {
          kind: "para",
          text: "Activity permitted under a bug bounty programme is not unauthorised, but it must affect only the organisation whose programme authorised it.",
        },
      ],
    },
    {
      id: "malware",
      heading: "Malware and attack infrastructure",
      blocks: [
        {
          kind: "para",
          text: "Do not use the Service to directly support unlawful attack or malware campaigns that are causing technical harm — for example by delivering malicious executables, organising denial-of-service attacks, running command-and-control servers, or hosting phishing kits.",
        },
        {
          kind: "para",
          text: "Security research, defensive tooling and proof-of-concept code are not covered by that sentence. What this prohibits is use with no purpose other than the abuse itself.",
        },
      ],
    },
    {
      id: "spam",
      heading: "Spam, phishing and bulk messaging",
      blocks: [
        {
          kind: "list",
          items: [
            "Do not send unsolicited bulk messages of any kind, or relay them through our infrastructure.",
            "Do not phish, or attempt to phish, anybody.",
            "Do not run inauthentic automated activity at scale, or create accounts by automated means.",
            "Do not use the Service to propagate abuse on other platforms.",
          ],
        },
      ],
    },
    {
      id: "mining-and-resale",
      heading: "Mining, and reselling what you rent",
      blocks: [
        {
          kind: "list",
          items: [
            "Do not use a machine rented from us for cryptocurrency mining.",
            "Do not resell the compute, bandwidth or storage of a machine rented from us, and do not resell access to the Service itself, without our written permission.",
          ],
        },
        {
          kind: "para",
          text: "Running your own builds, tests, dev servers and long jobs is the point of the product and is not what this section is about.",
        },
      ],
    },
    {
      id: "content",
      heading: "Content",
      blocks: [
        {
          kind: "para",
          text: "Do not use the Service to store, generate or transmit content that:",
        },
        {
          kind: "list",
          items: [
            "is unlawful, or promotes unlawful activity;",
            "sexually exploits or abuses children, or is sexually obscene;",
            "harasses, abuses, threatens or incites violence against any person or group;",
            "is libellous, defamatory or fraudulent;",
            "impersonates any person or organisation, or misrepresents your identity or your purpose;",
            "violates somebody's privacy, such as by publishing their personal information without consent;",
            "infringes anybody's patent, trademark, trade secret, copyright or other right;",
            "unlawfully shares licence keys, or software for generating or bypassing them.",
          ],
        },
      ],
    },
    {
      id: "our-service",
      heading: "The Service itself",
      blocks: [
        {
          kind: "list",
          items: [
            "Do not circumvent, disable or interfere with security or authentication features, or with the limits your account is subject to.",
            "Do not interfere with the relay, or attempt to read, alter or inject traffic belonging to anybody else.",
            "Do not collect or extract information or data from accounts that are not yours.",
            "Do not mislead us or other users, including by making false reports.",
            "Do not place an undue burden on our infrastructure by automated means.",
          ],
        },
      ],
    },
    {
      id: "excessive-use",
      heading: "Excessive use",
      blocks: [
        {
          kind: "para",
          text: "If your use of a shared resource is significantly excessive compared with other customers using the same features, we may throttle it or suspend it until it comes back down. We will reach out first unless the load is actively harming other people.",
        },
      ],
    },
    {
      id: "not-prohibited",
      heading: "What this policy does not prohibit",
      blocks: [
        {
          kind: "para",
          text: "Said plainly, because the lists above could be read far too widely by somebody whose job is security work:",
        },
        {
          kind: "list",
          items: [
            "Testing, scanning and attacking systems you own, or that you have written authorisation to test.",
            "Writing, reading and running exploit code, fuzzers, reverse-engineering tools and malware analysis, for research or defence.",
            "Running the Reemoat software yourself, modifying it, and operating your own control plane. That is what its licence is for, and this policy has nothing to say about it.",
            "Automating your own work heavily. Agents are supposed to run for hours.",
          ],
        },
      ],
    },
    {
      id: "enforcement",
      heading: "How we enforce this",
      blocks: [
        {
          kind: "ref",
          text: "We may remove content, suspend an account, or end the Service. The grounds, the notice you get and the chance to put it right are set out in",
          doc: "terms",
          label: "Terms of Use",
        },
        {
          kind: "para",
          text: "Where something is actively harming other people or our infrastructure we may act immediately and explain afterwards. Otherwise you get notice and an opportunity to fix it.",
        },
        {
          kind: "contact",
          text: "If we have suspended or ended something of yours and you think we got it wrong, say so and we will look again. Write to",
          email: OPERATOR.email,
        },
      ],
    },
    {
      id: "reporting",
      heading: "Reporting abuse",
      blocks: [
        {
          kind: "contact",
          text: "To report a breach of this policy, write to",
          email: OPERATOR.email,
        },
        {
          kind: "para",
          text: "Tell us what you saw, where you saw it and how you came across it. We will not tell the reported account who reported it. For a security vulnerability in the software itself, please use the process in the SECURITY.md file of our source repository instead.",
        },
      ],
    },
  ],
  credits: [
    {
      work: "GitHub Acceptable Use Policies",
      author: "GitHub",
      licence: "CC0 1.0",
      workUrl: "https://github.com/github/site-policy",
      licenceUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
    {
      work: "Basecamp open-source policies",
      author: "37signals",
      licence: "CC BY 4.0",
      workUrl: "https://github.com/basecamp/policies",
      licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
    },
  ],
};
