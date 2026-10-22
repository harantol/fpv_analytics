// Remplace le module du Blackbox Explorer du même nom, qui dépend de son interface
// (Vue/Pinia). Le parseur ne s'en sert que pour renommer les champs de debug.
export const FlightLogFieldPresenter = {
  adjustDebugDefsList() {},
};
