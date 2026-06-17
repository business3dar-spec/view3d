FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN mkdir -p uploads/images uploads/models
EXPOSE 3000
CMD ["node", "index.js"]
