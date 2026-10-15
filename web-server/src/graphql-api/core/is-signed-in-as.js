// Whether the request comes from the signed-in Steam user with this ID.
export default function isSignedInAs(context, steamUserID) {
  return Boolean(context.user && context.user.id) && context.user.id === steamUserID;
}
