const sessions =
  new Map();

export function getSession(
  token
) {
  return (
    sessions.get(token) ||
    null
  );
}

export function setSession(
  token,
  data
) {
  const existing =
    sessions.get(token) ||
    {};

  sessions.set(token, {
    ...existing,
    ...data,
    updatedAt:
      Date.now(),
  });

  return sessions.get(token);
}