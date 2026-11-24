# HADRISHOP — boutique d'impressions 3D

Boutique en ligne complète : catalogue, comptes clients, panier, paiements **Stripe Checkout**, livraison par codes postaux et rayon de 30 km, commandes sur mesure, vente de fichiers STL, Premium, newsletter et interface **/admin**.
Serveur Node.js + base **SQLite** persistante (fichier sur disque). Tout le code métier sensible s'exécute côté serveur.

> Les produits, prix, stocks et illustrations créés par `npm run seed-demo` sont des **exemples** à remplacer.

---

## 1. Ce qui est inclus

| Fonction | Où |
|---|---|
| Catalogue : photos, catégories, recherche, tri, variantes, stocks | Boutique `/` · Admin › Produits, Catégories |
| Comptes : inscription, confirmation d'e-mail, connexion, mot de passe oublié, suppression du compte | Boutique › Compte |
| Historique et suivi de commande (chronologie, n° de colis, e-mail à chaque étape) | Compte › Commandes · Admin › Commandes |
| Panier, codes promo (%, montant fixe, minimum, limites globale/par client, dates, réservé Premium) | Panier · Admin › Codes promo |
| Réservation du stock **15 minutes** pendant le paiement | automatique (tâche toutes les 30 s) |
| Paiement Stripe Checkout, webhooks signés, remboursements partiels/complets | Admin › Commandes, Remboursements |
| Livraison : retrait, liste de codes postaux, rayon autour de l'atelier (30 km par défaut) | Panier · Admin › Livraison |
| Commandes sur mesure (fichiers STL/3MF/OBJ/photos, devis, paiement) | Sur mesure · Admin › Sur mesure |
| Fichiers STL numériques (téléchargement sécurisé, nombre limité, révoqué si remboursé) | Compte › Téléchargements |
| Modification d'adresse (client : avant expédition et dans la même zone ; admin : toujours) | Commande · Admin › Commande |
| Premium (abonnement Stripe : remise, livraison offerte, produits réservés) | Premium · Admin › Paramètres, Clients |
| Newsletter (double confirmation, désinscription en un clic, campagnes) | Pied de page · Admin › Newsletter |
| Tableau de bord : ventes nettes par jour, KPI, meilleures ventes, stock bas, à traiter | Admin › Tableau de bord |
| Journal des actions admin et des événements Stripe, file d'e-mails | Admin › Journal, E-mails |

## 2. Sécurité et fiabilité (résumé)

- **Paiements** : montants calculés uniquement côté serveur ; webhook Stripe vérifié par signature sur le corps brut ; chaque événement est traité une seule fois (table `stripe_events`) ; une commande ne peut passer « payée » qu'une fois (état vérifié dans une transaction).
- **Double paiement** : clé de paiement par tentative (double clic = même session Stripe), une seule commande en attente par client (la précédente est annulée et sa session Stripe expirée), clés d'idempotence sur toutes les créations Stripe, une seule session Premium ouverte à la fois.
- **Stock** : réservation et décompte dans des transactions SQLite `IMMEDIATE` (sérialisées) + contrainte `CHECK (stock >= 0)` en base. Test : 12 achats simultanés pour 5 articles → exactement 5 réussites.
- **Réservation de 15 min** : Stripe impose une expiration de session d'au moins 30 min ; le serveur libère donc lui-même le stock après 15 min et expire la session Stripe. Si un paiement arrive malgré tout après l'expiration : la commande est honorée si le stock est encore libre, sinon elle est annulée et **remboursée automatiquement**.
- **Remboursements** : jamais au-delà du montant payé (remboursements en cours inclus, même en parallèle) ; remise en stock possible sur le solde ; remboursements faits depuis le Dashboard Stripe rattrapés par webhook.
- **Comptes** : mots de passe hachés avec scrypt (paramètres OWASP N=2¹⁶, r=8, p=2), sessions aléatoires stockées hachées, cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` en HTTPS), limitation des tentatives, réinitialisation à usage unique qui déconnecte tous les appareils, pas d'énumération des comptes.
- **Web** : protection CSRF (en-tête dédié + contrôle d'origine), CSP stricte (scripts autorisés par empreinte SHA-256, aucun `unsafe-inline` pour les scripts), `frame-ancestors 'none'`, téléversements validés par leur contenu réel (une image SVG/HTML déguisée est refusée), fichiers privés jamais servis publiquement, erreurs internes masquées.
- **Admin** : toutes les routes `/api/admin/*` exigent le rôle admin (test automatique sur chaque route), actions sensibles journalisées.

## 3. Installation locale (mode test Stripe)

Prérequis : Node.js 22.9 ou plus récent.

```bash
npm ci
cp .env.example .env          # puis remplissez APP_URL=http://localhost:3000, DATA_DIR=./data, clés Stripe de TEST
npm run seed-demo             # facultatif : catalogue d'exemple (dev uniquement)
npm run create-admin -- vous@exemple.be "Votre nom"   # le mot de passe est demandé ensuite
npm start                     # http://localhost:3000  et  http://localhost:3000/admin
```

Pour recevoir les webhooks en local, utilisez la Stripe CLI :
```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```
Elle affiche un secret `whsec_…` à mettre dans `STRIPE_WEBHOOK_SECRET`. Carte de test Stripe : `4242 4242 4242 4242`, date future, CVC quelconque.

## 4. Configuration de Stripe

1. **Clés API** : Dashboard Stripe › Développeurs › Clés API → `STRIPE_SECRET_KEY` (commencez par `sk_test_…`).
2. **Webhook** : Dashboard › Développeurs › Webhooks › Ajouter un endpoint : `https://VOTRE-DOMAINE/api/stripe/webhook`, avec les événements :
   - `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
   - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - `refund.updated`, `refund.failed`, `charge.refunded` (et `refund.created` s'il est proposé)

   Copiez le secret de signature dans `STRIPE_WEBHOOK_SECRET`.
3. **Moyens de paiement** (cartes, Bancontact, etc.) : à activer dans Dashboard › Paramètres › Moyens de paiement ; Checkout affiche automatiquement ceux qui sont actifs.
4. Passage en production : remplacez la clé et le secret par ceux du mode **live** et recréez l'endpoint webhook en mode live.

## 5. E-mails

Tout fournisseur SMTP convient (`SMTP_URL`). Les e-mails sont mis en file d'attente en base et réessayés automatiquement ; leur état est visible dans Admin › E-mails (bouton « M'envoyer un e-mail de test »). Twilio et SendGrid (société Twilio) ne sont pas utilisés.

## 6. Livraison par rayon de 30 km

1. Admin › Livraison : saisissez la **latitude/longitude de l'atelier** (le catalogue de démo met Bruxelles à titre d'exemple).
2. Rendez les codes postaux localisables, au choix :
   - importer le fichier GeoNames belge : téléchargez `BE.zip` sur `https://download.geonames.org/export/zip/`, extrayez `BE.txt`, puis Admin › Livraison › Importer (ou `npm run import-postcodes -- BE.txt`). Licence CC BY 4.0 : mentionnez GeoNames.
   - ou `GEOCODER=nominatim` : géocodage OpenStreetMap à la demande, limité à 1 requête/seconde et mis en cache, conformément à la politique d'usage de Nominatim.
3. Un code postal impossible à localiser n'est jamais accepté par erreur : la zone « rayon » est simplement indisponible pour lui.

## 7. Déploiement sur un serveur (VPS) avec Docker

```bash
# sur le serveur, dans le dossier du projet
cp .env.example .env && nano .env            # APP_URL=https://votre-domaine, clés Stripe, SMTP
nano Caddyfile                                # remplacez boutique.exemple.be par votre domaine
docker compose up -d --build
docker compose exec -it hadrishop node scripts/create-admin.js vous@exemple.be "Votre nom"
```

Caddy obtient et renouvelle automatiquement le certificat HTTPS dès que le domaine pointe vers le serveur (ports 80 et 443 ouverts).
Tout autre hébergeur Node.js convient **à condition de disposer d'un disque persistant** monté sur `DATA_DIR` et d'une **seule instance** (SQLite).

**Sauvegardes** : le volume `hadrishop-data` contient la base et les fichiers. Exemple quotidien :
`docker compose exec hadrishop node -e "require('better-sqlite3')('/data/hadrishop.sqlite').backup('/data/sauvegarde.sqlite')"` puis copiez `/data` hors du serveur.

## 8. Tests automatisés

```bash
npm test          # 51 tests API : paiement, concurrence, webhooks, remboursements, sécurité, fonctionnalités
npm run test:e2e  # 7 tests dans Chrome (CHROME_PATH=/chemin/vers/chrome si besoin)
```
Les tests utilisent un faux client Stripe (aucun appel réseau, aucun paiement) ; les webhooks sont signés et vérifiés avec la vraie bibliothèque Stripe.

## 9. À faire avant d'ouvrir la boutique

- Rédiger les **conditions générales de vente**, les mentions légales et la politique de confidentialité (Admin › Paramètres) — à faire valider, ce code n'est pas un conseil juridique.
- Prix affichés TVAC ; aucune facture n'est générée par l'application (les reçus Stripe peuvent être activés dans le Dashboard Stripe).
- Pas de double authentification (2FA) sur /admin : utilisez un mot de passe long et unique.
- Remplacer le catalogue et les illustrations d'exemple par vos produits et photos.

## Sources

- Stripe — expiration des sessions Checkout (30 min minimum) : https://docs.stripe.com/payments/checkout/abandoned-carts
- Stripe — gestion d'un stock limité et expiration manuelle : https://docs.stripe.com/payments/checkout/managing-limited-inventory
- Stripe — webhooks (signature sur corps brut, événements dupliqués) : https://docs.stripe.com/webhooks
- Stripe — période d'abonnement déplacée sur les items (API Basil) : https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
- Stripe — suppression de `payment_method_types` pour Checkout (API Endive) : https://docs.stripe.com/changelog/endive
- Stripe — remboursements asynchrones (`refund.updated`, `refund.failed`) : https://docs.stripe.com/testing
- OWASP — stockage des mots de passe (scrypt) : https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- Nominatim — politique d'usage : https://operations.osmfoundation.org/policies/nominatim/
- Caddy — HTTPS automatique : https://caddyserver.com/docs/automatic-https
- Elegoo Neptune 4 Pro — volume d'impression 225 × 225 × 265 mm (valeur par défaut du formulaire sur mesure) : https://www.elegoo.com/collections/pre-owned-3d-printer/products/elegoo-neptune-4-pro-fdm-3d-printer
