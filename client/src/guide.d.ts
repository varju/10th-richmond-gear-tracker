/** The user guide, compiled from docs/guide/*.md by the gear-guide plugin in vite.config.ts. */
declare module "virtual:guide" {
  export interface GuideSection {
    /** The file's name, and the anchor for the section. */
    id: string;
    /** The file's one h1. */
    title: string;
    /** The rest of the file, as HTML. */
    html: string;
    /** The contents: every task, or every group with its tasks. */
    headings: GuideHeading[];
  }
  export interface GuideHeading {
    id: string;
    text: string;
    children: GuideHeading[];
  }
  export const sections: GuideSection[];
}
