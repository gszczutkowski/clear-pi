# Clear-pi — weryfikacja napraw po audycie

## P1 — poprawność eksportu, prywatność i płynność dashboardu

- [x] **Nie eksportować raportu innej gałęzi.** `progress.ts` wiąże projekcję z sesją, plikiem sesji i końcem aktywnej gałęzi. Po zmianie gałęzi (również przy wyłączonym panelu lub podczas opóźnionego odświeżania) eksport bez aktualnego snapshotu nie tworzy pliku i wskazuje `/clear-progress refresh`. Zgodna projekcja nie wymaga ponownego odczytu. Tuż przed zapisem następuje jeszcze jedna kontrola aktualności.
- [x] **Nie ujawniać celów hiperłączy terminalowych.** `progress-data.ts` usuwa całe sekwencje OSC 8 przed czyszczeniem znaków sterujących. Testy BEL i ST sprawdzają zachowanie etykiety i brak adresu w projekcji, TUI i HTML. Eksport pozostaje lokalny, z escapowaniem HTML i polityką blokującą skrypty i zasoby sieciowe.
- [x] **Usunąć synchroniczne ponowne skanowanie historii.** `progress-data.ts` asynchronicznie sprawdza metadane z ograniczoną równoległością, odczytuje treść nowych lub zmienionych zdarzeń i ponownie weryfikuje pochodzenie zdarzeń przy każdym odczycie. `progress.ts` filtruje powiadomienia po nazwie pliku (przy braku nazwy zleca odświeżenie), grupuje je i odrzuca spóźnione projekcje. Wyszukiwanie wcześniejszego rodzica korzysta z indeksu zakresu i tożsamości. Odczyt metadanych nadal rośnie wraz z liczbą plików, ale nie blokuje TUI na czas operacji dyskowych.

## P2 — ograniczenie kosztu renderowania

- [x] **Usunąć bezwarunkowe przerysowanie co sekundę.** `index.ts` i `usage.ts` planują pobrania oraz odświeżenia licznika według najbliższej rzeczywistej zmiany. Poza Codexem, poza TUI oraz przy wyłączonej opcji quota nie ma timera ani zapytań. Przełączenie providera i zamknięcie sesji anulują bieżącą pracę; limit ręcznego odświeżania nadal wynosi 10 s.
- [x] **Buforować statystyki stopki.** `footer.ts` kluczuje dane przez sesję, koniec gałęzi, liczbę wpisów i wybrany model z limitem kontekstu. Zmiany gałęzi, wpisów, modelu i kompakcji wymuszają przeliczenie. Dla modeli wirtualnych procent kontekstu odczytywany jest na bieżąco, bo publiczne API nie udostępnia rzeczywistego modelu użytego do obliczenia limitu.
- [x] **Nie odtwarzać zakończonych tur przy każdym renderze transkryptu.** `tool-groups.ts` buforuje stabilne fragmenty. Testy weryfikują zmianę szerokości, motywu, gałęzi i rozwinięcia oraz routing myszy i zachowanie obrazów. Bieżąca tura, rozwinięte narzędzia i transport obrazów pozostają renderowane na bieżąco.
- [x] **Nie przebudowywać pełnego raportu przy przewijaniu.** `progress.ts` buforuje wiersze według projekcji, szerokości i limitów widoku. Strzałki, Page Up/Down i kółko wybierają widoczny zakres bez ponownego przeliczania raportu.

## P2 — historia i zgodność z Pi

- [x] **Nie przypisywać potomka do późniejszego wznowienia rodzica.** Gdy brak potwierdzonego wcześniejszego rodzica, run zostaje nieprzypisany, a raport sygnalizuje niepełne dane. Wynik subagenta nie zmienia stanu akceptacji zadania.
- [x] **Udokumentować i testować zgodność z Pi.** `package.json` deklaruje sprawdzoną wersję **Pi 1.6.0**. Test integracyjny używa faktycznego runtime i TUI Pi z symulowanym terminalem i dostawcą offline. Obejmuje streaming, tryb zwykły i fullscreen, natywną kartę narzędzia, mysz, zmianę gałęzi i natywny widok przy nieznanym układzie. Nie deklarujemy zgodności z innymi wersjami ani nie weryfikujemy fizycznego terminala.

## Kolejna runda napraw po review

- [x] Raport nie myli werdyktu agenta ze statusem pojedynczego testu, pomija przykłady w blokach kodu i rozpoznaje `APPROVED` / `NEEDS CHANGES` herdr jako deklarowane wyniki, nie formalną akceptację.
- [x] `expand` i `full` czekają na aktualne dane po zdarzeniu obserwatora i odczytują pliki na żądanie, gdy obserwacja nie obejmuje całego zakresu. Eksport pozostaje oparty na cache. Poprawne dane siostrzanych uruchomień nie wpływają na liczniki aktywnego zakresu.
- [x] Pojedyncze kliknięcie grupy narzędzi unieważnia tylko jej fragment transkryptu. Benchmark mierzy teraz również render po kliknięciu.
- [x] Karty **Skill invoked** i **Needs help** można rozwinąć kliknięciem w fullscreen albo wspólnym `Ctrl+O`; konfiguracja pozwala przywrócić natywną kartę dla każdego typu. Nieznane klucze konfiguracji zgłaszają ostrzeżenie przy wczytywaniu.
- [x] Stopka Codex nie myli pojedynczego okna `secondary` z `primary`, gdy brak czasu trwania.

Weryfikacja: Node 24.21.0, Pi 1.6.0, `npm run typecheck`, **156/156** testów i trzy benchmarki. Kliknięcie grupy w próbce 500 tur wywołało **4** rendery wiadomości asystenta i zajęło ok. **0,40 ms** (mediana siedmiu pomiarów samego renderu, bez zapisu do terminala). Test integracyjny potwierdził obsługę kart myszą i `Ctrl+O` w symulowanym terminalu; nie uruchamiano rzeczywistego herdr ani endpointu Codex.

## Weryfikacja wcześniejszej rundy (historyczna)

- `npm test`: **92/92 PASS**, bez pominiętych testów (Node 24.21.0, Pi 1.6.0).
- `git diff --check`: bez błędów białych znaków; Git ostrzega o lokalnej konwersji LF/CRLF.
- Benchmark dashboardu (100 / 500 / 2000 zdarzeń): pierwszy odczyt **28,54 / 105,15 / 919,47 ms**, zmiana jednego pliku **19,75 / 38,00 / 205,51 ms**, timer **0,47 / 0,91 / 1,11 ms**. Wyniki są zależne od obciążenia i cache systemu plików.
- Benchmark transkryptu (20 / 200 / 500 tur): natywny **0,022 / 0,178 / 0,346 ms**, z ramkami **0,082 / 0,210 / 0,364 ms**. To nie jest pomiar fizycznego terminala ani porównanie z historyczną implementacją.
- **Ograniczenie integracji:** test z rzeczywistym runtime Pi nie ładuje rzeczywistego rozszerzenia `pi-herdr-subagents`. Zgodność adaptera herdr jest sprawdzana na ręcznie tworzonych danych i imitacji renderera; zmiany kontraktu upstream mogą wymagać osobnej weryfikacji.
- Niezależne review poprawności i regresji zatwierdziło zmiany bez usterek wymagających poprawy; sprawdzono custody/lineage, eksport, czyszczenie UI, cache transkryptu i harmonogram quota.
- Niezależny audyt bezpieczeństwa nie wykazał nowych podatności wymagających poprawy. Odczyt historii wymaga uprawnień lineage aktywnej gałęzi; eksport escapuje HTML, blokuje zasoby sieciowe i nie nadpisuje plików.
- Model zaufania zakłada system plików tego samego użytkownika: nie zapewnia atomowej ochrony przed podmianą ścieżek i symlinkami. Eksport może zawierać prywatne fragmenty zadań i wyników; redakcja wzorcami nie gwarantuje usunięcia sekretów. Przed udostępnieniem należy sprawdzić raport.
- Nie wykonywano rzeczywistych zapytań quota, testów fizycznego terminala, weryfikacji Windows ACL ani adversarialnych wyścigów systemu plików. Nie uruchamiano statycznego typechecku (brak skryptu w projekcie).

## Historyczne wyniki odbioru

Windows, Node 24.21.0, Pi 1.6.0: **`npm test` — 79/79** (65/65 przed naprawami). Bez dodatkowych wywołań modelu, narzędzi modelu lub zmian promptu; testy quota nie wywołują rzeczywistego HTTPS.

`npm run bench:progress`: mediana siedmiu pomiarów po rozgrzaniu. „Pierwszy” oznacza pusty cache aplikacji, nie zimny cache systemu plików. Timer zaplanowany na początku odczytu obrazuje wczesne oddanie sterowania pętli zdarzeń; nie jest pomiarem maksymalnego opóźnienia.

| Zdarzenia | Pierwszy odczyt | Zmiana jednego pliku | Czas do timera przy pierwszym odczycie |
| ---: | ---: | ---: | ---: |
| 100 | 61,82 ms | 38,79 ms | 0,76 ms |
| 500 | 223,28 ms | 66,14 ms | 1,02 ms |
| 2000 | 559,13 ms | 115,05 ms | 2,08 ms |

Audyt podawał 34 / 112 / 455 ms dla synchronicznego odczytu 100 / 500 / 2000 plików. Pierwotna próbka nie jest dostępna, więc nie jest to porównanie bezpośrednie. Zmiana usuwa blokujący odczyt, nie gwarantuje krótszego czasu pierwszej projekcji.

`npm run bench:transcript`: mediana 40 renderów przy szerokości 100 po 10 rozgrzewkowych, bez stopki i zapisu do terminala. W lokalnym porównaniu na tej samej próbce (bieżące ramki i konfiguracja, zmieniona wyłącznie wersja `tool-groups.ts`) render z ramkami spadł z **0,782 / 8,180 / 22,643 ms** do **0,090 / 0,177 / 0,299 ms** dla 20 / 200 / 500 tur. Pomiar dotyczy rozgrzanego widoku ze zwiniętymi narzędziami, nie całego terminala ani pierwszego renderu.
