/** Gitea refused a request for this account: 401, 403 or 404. */
export class GiteaAccessError extends Error {}
export class GiteaAuthenticationError extends GiteaAccessError {}
/** Gitea answered 404: the item does not exist, or this account cannot see it. */
export class GiteaNotFoundError extends GiteaAccessError {}
