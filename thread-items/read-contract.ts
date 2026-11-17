import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { threadPullsSchema } from "./contract.js";

/** Every keyed pull request read carries this tag; the server invalidates it whenever a link or a stored state changes. */
export const threadPullsTag = "thread-pulls";

/** One thread's rows also carry this tag, for a change only that thread can see, such as a child thread it gained. */
export const threadPullsKeyTag = (threadId: string) => `${threadPullsTag}:${threadId}`;

const maxKeys = 200;
const keyedRead = {
  input: z.object({ keys: z.array(z.string().min(1)).min(1).max(maxKeys) }).strict(),
  output: z.record(z.string(), threadPullsSchema),
  keyTags: (key: string) => [threadPullsTag, threadPullsKeyTag(key)],
};

export const threadPullsRpcMethods = {
  threadPulls: {
    ...keyedRead,
    experimental_description:
      "Each thread's Gitea pull requests and its child threads', keyed by thread id. While a client watches a thread, its new commands are read and its open pull requests refresh every 30 seconds.",
  },
};

/** The keyed reads the app makes, apart from the server's full contract so the app bundle loads no server code. */
export const threadPullsReadContract = defineRpcContract(threadPullsRpcMethods);
