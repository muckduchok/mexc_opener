generator client {
provider = "prisma-client-js"
}

datasource db {
provider = "mongodb"
url = env("DATABASE_URL")
}

enum Role {
OWNER
ADMIN
UPBIT
TWITTER
EVENTS
USER
}

type EventField {
key      String
label    String
type     String
required Boolean? @default(false)
defaultValue  String?
placeholder String?
min String?
max String?
}

model User {
id        String    @id @map("_id") @default(auto()) @db.ObjectId
username  String    @unique
password  String
accounts  Account[]
twitters  Twitter[]
closeInterval Boolean?
roles      Role[]  @default([USER])
createdAt DateTime  @default(now())
updatedAt DateTime  @updatedAt
}

model Account {
id          String   @id @map("_id") @default(auto()) @db.ObjectId
userId      String   @db.ObjectId
user        User     @relation(fields: [userId], references: [id])
exchange    String
label       String?
apiKey      String
apiSecret   String
passphrase  String?
margin      String?
takeProfit  Int?
leverage    Int?
timer       String?
connection  String?
buyType     String?
type        String?
cookie      String?
side        String?
marketCap   String?
balance     Float?
proxy       String?
lockedBy    String?
leaseExpiresAt DateTime?
error       Boolean?
apiKeyExpired  Boolean?
cookieExpired  Boolean?
disabled    Boolean?
groupId     String?
comission   String?
createdAt   DateTime @default(now())

@@index([userId, exchange])
@@index([userId, createdAt])
@@index([userId, disabled])
}

model OrdersAccount {
id          String   @id @map("_id") @default(auto()) @db.ObjectId
userId      String   @db.ObjectId
exchange    String
label       String?
apiKey      String
apiSecret   String
passphrase  String?
margin      String?
takeProfit  Int?
connection  String?
type        String?
cookie      String?
side        String?
marketCap   String?
balance     Float?
proxy       String?
lockedBy    String?
leaseExpiresAt DateTime?
error       Boolean?
apiKeyExpired  Boolean?
cookieExpired  Boolean?
disabled    Boolean?
groupId     String?
isMobile    Boolean?
comission   String?
createdAt   DateTime @default(now())

@@index([userId, exchange])
@@index([userId, createdAt])
@@index([userId, disabled])
@@index([userId, isMobile])
}

model Listings {
id            String   @id @map("_id") @default(auto()) @db.ObjectId
userId        String   @db.ObjectId
accountId     String   @db.ObjectId
accountLabel  String
exchange      String
margin        Int?
takeProfit    Float?
side          String
event         String
twitterUsername String?
tokenWaiting  String?
marketCap     Int?
premarket     Boolean?
tokenInteract String?
address       String?
prompt        String?
longAll       Boolean?
customFields  String?
createdAt     DateTime @default(now())

@@index([accountId, userId])
}

model EventsList {
id        String    @id @map("_id") @default(auto()) @db.ObjectId
name      String
key       String    @unique
roles     Role[]    @default([USER])
fields    EventField[]
createdAt DateTime  @default(now())
}

model Twitter {
id          String   @id @map("_id") @default(auto()) @db.ObjectId
userId      String   @db.ObjectId
user        User     @relation(fields: [userId], references: [id])
label       String?
margin      String?
side        String?
keywords    String?
createdAt   DateTime @default(now())

@@index([userId, label])
}

enum BalanceSnapshotAccountType {
EXCHANGE
ORDERS
}

type BalanceSnapshotPoint {
id         String
day        String
snapshotAt DateTime
balance    Float
}

model GmStatus {
id        String  @id @map("_id")
enabled   Boolean @default(true)
}

model ToolSettings {
id        String   @id @map("_id")
userId    String   @db.ObjectId
toolKey   String
data      Json
updatedAt DateTime @updatedAt

@@unique([userId, toolKey])
@@index([userId])
}

model BalanceSnapshotAccount {
id              String                    @id @map("_id") @default(auto()) @db.ObjectId
userId          String                    @db.ObjectId
accountType     BalanceSnapshotAccountType
accountId       String                    @db.ObjectId
exchange        String?
label           String?
accountCreatedAt DateTime?
createdAt       DateTime                  @default(now())
snapshots       BalanceSnapshotPoint[]

@@unique([userId, accountType, accountId])
@@index([userId, accountType])
@@index([userId, accountId])
}
