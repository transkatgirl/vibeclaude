export const findSavedDevice = (devices, saved) => {
  const exactMatch = devices.find((device) => device.index === saved.index && device.name === saved.name);
  if (exactMatch) return exactMatch;

  const nameMatches = devices.filter((device) => device.name === saved.name);
  return nameMatches.length === 1 ? nameMatches[0] : undefined;
};
