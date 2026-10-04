/** Short, well-known quotes on design and making. One per day, the same for everyone. */
export type Quote = { text: string; author: string };

export const QUOTES: readonly Quote[] = [
  { text: "Less, but better.", author: "Dieter Rams" },
  { text: "The details are not the details. They make the design.", author: "Charles Eames" },
  { text: "Design is not just what it looks like and feels like. Design is how it works.", author: "Steve Jobs" },
  { text: "Styles come and go. Good design is a language, not a style.", author: "Massimo Vignelli" },
  { text: "Design is thinking made visual.", author: "Saul Bass" },
  { text: "Design is so simple, that's why it is so complicated.", author: "Paul Rand" },
  { text: "Have nothing in your houses that you do not know to be useful, or believe to be beautiful.", author: "William Morris" },
  { text: "Good design is as little design as possible.", author: "Dieter Rams" },
  { text: "Form follows function.", author: "Louis Sullivan" },
  { text: "Recognizing the need is the primary condition for design.", author: "Charles Eames" },
  { text: "Creativity is just connecting things.", author: "Steve Jobs" },
  { text: "Good design is obvious. Great design is transparent.", author: "Joe Sparano" },
  { text: "The best way to have a good idea is to have lots of ideas.", author: "Linus Pauling" },
  { text: "Quality is never an accident; it is always the result of intelligent effort.", author: "John Ruskin" },
  { text: "Simplicity is about subtracting the obvious and adding the meaningful.", author: "John Maeda" },
  { text: "Whatever you do, do it well.", author: "Walt Disney" },
];

/** Days since the Unix epoch in UTC, so the quote changes at the same moment for everyone. */
export function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000);
}

export function quoteOfTheDay(date: Date = new Date()): Quote {
  // A fixed stride walks through the list in a non-obvious order without repeating
  // until every quote has been shown (stride is coprime with the list length).
  const index = (dayNumber(date) * 7) % QUOTES.length;
  return QUOTES[index]!;
}
