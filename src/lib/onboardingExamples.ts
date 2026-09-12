import type { PersonalizationContext } from "./types";

export const STARTER: Record<PersonalizationContext, string[]> = {
  default: [
    "I wanted to follow up regarding the meeting we discussed last week. Please let me know if you have any availability this week.",
    "Thanks for your help with this. Let me know if you need anything else from me.",
    "Could we reschedule for later this week? I'm flexible on timing.",
  ],
  email: [
    "Just checking in on the proposal. Let me know if you need anything else from me.",
    "Could we move our call to Thursday? Happy to work around your schedule.",
    "Wanted to follow up on the email below. Any update?",
  ],
  text: [
    "Hey, are we still on for tonight? Let me know what time works for you.",
    "Quick question: did you get a chance to look at that file?",
    "Can you send that over when you have a sec? Thanks!",
  ],
  social: [
    "Really excited to share what our team has been working on this quarter.",
    "Hot take: the best ideas often start as messy drafts.",
    "Quick recommendation: this article nails the problem we've been discussing.",
  ],
  work: [
    "Quick update: the draft is ready for review. Let me know if anything needs changing.",
    "Request: could you approve the budget by EOD so we can proceed?",
    "Following up on the project timeline. Are we still on track for Friday?",
  ],
};

export function getStarter(ctx: PersonalizationContext, idx = 0): string {
  const list = STARTER[ctx] ?? STARTER.default;
  return list[idx % list.length] ?? list[0] ?? "";
}

export type DemoExample = {
  title: string;
  input: string;
};

export const DEMO_EXAMPLES: Record<PersonalizationContext, DemoExample[]> = {
  default: [
    {
      title: "Messy thought",
      input:
        "I don't think we should launch this yet because there's still a bunch of stuff that doesn't work and I don't want us to rush it just because we said we'd have it done this week.",
    },
    {
      title: "Too wordy",
      input:
        "Just wanted to let you know that I was looking into this and I think that maybe the reason we're seeing this issue is because of the way the data is being processed before it gets sent over.",
    },
    {
      title: "Awkward wording",
      input:
        "I appreciate you reaching out to me regarding this opportunity and I would definitely be interested in learning more about what the position entails.",
    },
    {
      title: "Natural voice",
      input:
        "honestly this is probably the best version we've had so far but i still think the onboarding is kinda confusing and people are going to get stuck",
    },
    {
      title: "Same thought, different style",
      input:
        "I don't think this is ready. We should probably spend another week fixing the main issues before we ship it.",
    },
  ],
  email: [
    {
      title: "Follow up",
      input: "Hey, just checking if you saw my email from last week. Let me know when you get a chance.",
    },
    {
      title: "Say no",
      input: "Thanks but we're going to pass on this for now. It's not really what we're looking for.",
    },
    {
      title: "Make a request",
      input: "Can you send me the numbers today? I need them to finish the presentation.",
    },
    {
      title: "Apologize",
      input: "Sorry I didn't get back to you sooner. Things have been crazy and I completely missed this.",
    },
    {
      title: "Reschedule",
      input: "We need to move the meeting because I won't have everything ready by Thursday.",
    },
  ],
  text: [
    {
      title: "Running late",
      input: "Hey I might be a little late because traffic is really bad but I'm on my way",
    },
    {
      title: "Too formal",
      input:
        "Unfortunately, I will not be able to attend tonight due to a prior commitment. I apologize for any inconvenience.",
    },
    {
      title: "Too blunt",
      input: "You didn't send me the thing I asked for so I can't finish this.",
    },
    {
      title: "Too long",
      input:
        "I think we should probably just go tomorrow instead because if we go tonight we're going to have to rush and I don't think it's worth it just to go one day earlier.",
    },
    {
      title: "Same thought, different style",
      input: "I can't come tonight because I have too much going on and I really need to get some things done.",
    },
  ],
  social: [
    {
      title: "Personal observation",
      input:
        "I've been using this for a few weeks and honestly didn't expect to like it this much. It's really simple but that's kind of why it works.",
    },
    {
      title: "Strong opinion",
      input:
        "I think most productivity apps are making things more complicated than they need to be. I don't need another dashboard. I just need to remember what I'm supposed to do.",
    },
    {
      title: "Quick thought",
      input: "spent way too long trying to fix this thing and then realized the problem was one line of code",
    },
    {
      title: "Keep personality",
      input:
        "everyone keeps talking about how hard it is to build something but honestly getting people to actually use it is way harder",
    },
    {
      title: "Same thought, different style",
      input:
        "I finally finished the project. It took much longer than I expected but I'm pretty happy with how it turned out.",
    },
  ],
  work: [
    {
      title: "Design feedback",
      input:
        "This design looks good but I think there are too many things happening on the page and the user won't know what they're supposed to click.",
    },
    {
      title: "Disagree",
      input: "I don't think this is the right approach. We've already tried something similar and it didn't work.",
    },
    {
      title: "Meeting notes",
      input:
        "onboarding is too long. people don't understand why we're asking all these questions. also the second screen is confusing.",
    },
    {
      title: "Make actionable",
      input: "Can someone look at this? It's been broken for a while and we need to fix it.",
    },
    {
      title: "Launch decision",
      input: "I don't think we should launch this week. There are still too many things that need fixing.",
    },
  ],
};

export function getDemoExamples(ctx: PersonalizationContext): DemoExample[] {
  return DEMO_EXAMPLES[ctx] ?? DEMO_EXAMPLES.default;
}

export const DOMAIN_SUGGESTIONS = [
  "gmail.com",
  "outlook.com",
  "linkedin.com",
  "reddit.com",
  "x.com",
  "twitter.com",
  "slack.com",
  "facebook.com",
  "customcompany.com",
];
